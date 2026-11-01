// 进展证据（progress.artifactHash / progress.actionHash）的判据测试。
//
// 为什么要单独测（2026-10-31 Super-agent 卡 T3）：契约方是 dsfolder 的
// `scripts/agent-progress-watchdog.mjs`，它只在**有真值**时才判 progress/stalled/drifting，
// 缺字段必须判 unknown（exit 2）。所以生产端这边任何一个"凑数"的实现都会直接把
// 那个 watchdog 变成永远绿的假判据：
//   · 未声明 artifactPaths 却写了 progress  ⇒ unknown 被洗成 progress/stalled；
//   · 文件读不到却写一个空集哈希           ⇒ 得到一个永远不变的 artifactHash（伪装成 stalled）；
//   · actionHash 取渲染后的 prompt         ⇒ 每次触发都变（drifting 被洗成 stalled）。
// 因此每条"该有"的用例都配一条负向控制（未声明 / 读不到 / 动作未变）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  computeActionHash,
  computeProgress,
  dateVars,
  hashFileSync,
} from '../lib/progress-hash.mjs'

const pluginHref = pathToFileURL(
  `${process.env.HOME}/.dsh/profiles/web/node_modules/dsh-scheduler/index.mjs`,
).href
const fixtureHarness = new URL('./fixtures/fake-harness', import.meta.url).pathname
const WATCHDOG = process.env.DSFOLDER_WATCHDOG
  ?? `${process.env.HOME}/syncfolder/project/dsfolder/scripts/agent-progress-watchdog.mjs`

// ── 纯函数 ───────────────────────────────────────────────────────────────────

const baseJob = {
  id: 'job-x',
  name: 'demo',
  workspace: '/tmp/ws',
  prompt: 'produce report {{DSH_SCHED_RUN_KEY}}',
  model: { provider: 'p', model: 'm' },
  assertCmd: 'test -s out.md',
  trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
  enabled: true,
  maxAttempts: 3,
  timeoutMs: 900_000,
}

test('computeActionHash：同一份动作声明 → 同一个哈希（跨调用稳定）', () => {
  assert.equal(computeActionHash(baseJob), computeActionHash({ ...baseJob }))
  // 键顺序不影响（stableStringify 排序）
  const reordered = {
    artifactPaths: undefined,
    ...Object.fromEntries(Object.entries(baseJob).reverse()),
  }
  assert.equal(computeActionHash(reordered), computeActionHash(baseJob))
})

test('computeActionHash：换动作必须换哈希（prompt / workspace / model / assertCmd）', () => {
  const base = computeActionHash(baseJob)
  assert.notEqual(computeActionHash({ ...baseJob, prompt: 'produce something else' }), base)
  assert.notEqual(computeActionHash({ ...baseJob, workspace: '/tmp/other' }), base)
  assert.notEqual(computeActionHash({ ...baseJob, model: { provider: 'p', model: 'm2' } }), base)
  assert.notEqual(computeActionHash({ ...baseJob, assertCmd: 'true' }), base)
})

test('computeActionHash：调度/标签/重试策略不是动作 —— 不得参与哈希', () => {
  const base = computeActionHash(baseJob)
  assert.equal(computeActionHash({ ...baseJob, name: 'renamed' }), base)
  assert.equal(
    computeActionHash({ ...baseJob, trigger: { kind: 'interval', expression: '1h', everySeconds: 3600 } }),
    base,
  )
  assert.equal(computeActionHash({ ...baseJob, enabled: false }), base)
  assert.equal(computeActionHash({ ...baseJob, maxAttempts: 9, timeoutMs: 60_000 }), base)
  // 受检面变了 ≠ 动作变了（否则"换了检查项"会被误判成"换了做法"）
  assert.equal(computeActionHash({ ...baseJob, artifactPaths: ['a.md'] }), base)
})

test('computeProgress：未声明 artifactPaths ⇒ 不产出 progress（watchdog 只能判 unknown）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'progress-decl-'))
  writeFileSync(join(dir, 'a.md'), 'v1')
  for (const job of [{ ...baseJob }, { ...baseJob, artifactPaths: [] }, { ...baseJob, artifactPaths: null }]) {
    const out = computeProgress(job, { cwd: dir })
    assert.equal(out.declared, false)
    assert.equal(out.progress, null, '没有声明就不能有 progress（假绿入口）')
    assert.equal(out.reason, 'no-artifactPaths-declared')
  }
})

test('computeProgress：产物内容变 → 哈希变；内容不变 → 哈希不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'progress-hash-'))
  const file = join(dir, 'report.md')
  writeFileSync(file, 'run 1')
  const job = { ...baseJob, workspace: dir, artifactPaths: ['report.md'] }
  const first = computeProgress(job)
  assert.equal(first.declared, true)
  assert.match(first.progress.artifactHash, /^[0-9a-f]{64}$/)
  assert.match(first.progress.actionHash, /^[0-9a-f]{64}$/)
  assert.equal(first.progress.artifactBytes, 5)

  // 同样的内容再算一次：同一个哈希（否则 watchdog 会把"稳定"读成"在变"）
  assert.equal(computeProgress(job).progress.artifactHash, first.progress.artifactHash)

  // 内容变一个字节：哈希必须变
  writeFileSync(file, 'run 2')
  assert.notEqual(computeProgress(job).progress.artifactHash, first.progress.artifactHash)
})

test('computeProgress：声明了但读不到 ⇒ 只报问题，不给 artifactHash（不许空集哈希冒充）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'progress-missing-'))
  const job = { ...baseJob, workspace: dir, artifactPaths: ['missing.md'] }
  const out = computeProgress(job)
  assert.equal(out.declared, true)
  assert.equal(out.progress.artifactHash, undefined)
  assert.equal(out.reason, 'artifact-unreadable')
  assert.deepEqual(out.progress.artifactProblems, ['missing.md: unreadable(ENOENT)'])
  // 动作哈希仍然有：动作确实发生了，只是产物面判不了
  assert.match(out.progress.actionHash, /^[0-9a-f]{64}$/)
})

test('computeProgress：多产物时任一读不到就整体不给哈希（不允许"部分证据"冒充满证据）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'progress-partial-'))
  writeFileSync(join(dir, 'a.md'), 'ok')
  const out = computeProgress({ ...baseJob, workspace: dir, artifactPaths: ['a.md', 'b.md'] })
  assert.equal(out.progress.artifactHash, undefined)
  assert.deepEqual(out.progress.artifactProblems, ['b.md: unreadable(ENOENT)'])
})

test('computeProgress：目录不是产物（not-a-file），且 ~ 展开与绝对路径可解析', () => {
  const dir = mkdtempSync(join(tmpdir(), 'progress-dir-'))
  const abs = join(dir, 'abs.md')
  writeFileSync(abs, 'x')
  writeFileSync(join(dir, 'rel.md'), 'y')
  const byAbs = computeProgress({ ...baseJob, artifactPaths: [abs] })
  assert.match(byAbs.progress.artifactHash, /^[0-9a-f]{64}$/)
  const byRel = computeProgress({ ...baseJob, workspace: dir, artifactPaths: ['rel.md'] })
  assert.match(byRel.progress.artifactHash, /^[0-9a-f]{64}$/)
  const asDir = computeProgress({ ...baseJob, workspace: dir, artifactPaths: ['.'] })
  assert.equal(asDir.progress.artifactHash, undefined)
  assert.deepEqual(asDir.progress.artifactProblems, ['.: not-a-file'])
  // 声明路径参与聚合：同一份内容、不同声明路径 ⇒ 不同 artifactHash（换检查项可区分）
  assert.notEqual(byAbs.progress.artifactHash, byRel.progress.artifactHash)
})

test('hashFileSync：内容相同 → 摘要相同；不可读 → ok=false 并点名原因', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hash-file-'))
  const a = join(dir, 'a'), b = join(dir, 'b')
  writeFileSync(a, 'same')
  writeFileSync(b, 'same')
  assert.equal(hashFileSync(a).sha256, hashFileSync(b).sha256)
  writeFileSync(b, 'different')
  assert.notEqual(hashFileSync(a).sha256, hashFileSync(b).sha256)
  const missing = hashFileSync(join(dir, 'nope'))
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /unreadable/)
})

test('dateVars：按作业时区折算日期；非法时区回退不抛（timezone 是自由文本）', () => {
  assert.deepEqual(dateVars('2026-11-01T00:30:00+08:00', 'Asia/Shanghai'), { date: '2026-11-01', dateCompact: '20261101' })
  // 同一时刻在 UTC 还是 10-31 —— 时区必须参与，否则跨时区作业的产物会指错日子
  assert.equal(dateVars('2026-11-01T00:30:00+08:00', 'UTC').date, '2026-10-31')
  assert.doesNotThrow(() => dateVars('2026-11-01T00:30:00+08:00', 'Not/AZone'))
  assert.match(dateVars('nonsense', undefined).date, /^\d{4}-\d{2}-\d{2}$/)
})

test('computeProgress：日期占位符解析到真实文件，但哈希里进的是模板（日期变化不算"产物在变"）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'progress-date-'))
  writeFileSync(join(dir, 'r-2026-10-31.md'), 'same body')
  const job = { ...baseJob, workspace: dir, artifactPaths: ['r-{{DSH_SCHED_DATE}}.md'] }
  const a = computeProgress(job, { vars: dateVars('2026-10-31T09:00:00+08:00', 'Asia/Shanghai') })
  assert.match(a.progress.artifactHash, /^[0-9a-f]{64}$/)
  assert.deepEqual(a.progress.artifactPaths, ['r-{{DSH_SCHED_DATE}}.md'], '台账里保留声明模板')
  // 同内容、不同日期 ⇒ 同一个 artifactHash：否则"每天一个新文件名"会被 watchdog 读成 progress
  writeFileSync(join(dir, 'r-2026-11-01.md'), 'same body')
  const b = computeProgress(job, { vars: dateVars('2026-11-01T09:00:00+08:00', 'Asia/Shanghai') })
  assert.equal(b.progress.artifactHash, a.progress.artifactHash)
  // 负向控制：那天没有产物 ⇒ 读不到（不许把"模板相等"冒充成"产物稳定"）
  const c = computeProgress(job, { vars: dateVars('2026-11-02T09:00:00+08:00', 'Asia/Shanghai') })
  assert.equal(c.progress.artifactHash, undefined)
  assert.deepEqual(c.progress.artifactProblems, ['r-{{DSH_SCHED_DATE}}.md: unreadable(ENOENT)'])
  // 内容变了 ⇒ 哈希必须变（占位符没有把内容判据吃掉）
  writeFileSync(join(dir, 'r-2026-11-03.md'), 'different body')
  const d = computeProgress(job, { vars: dateVars('2026-11-03T09:00:00+08:00', 'Asia/Shanghai') })
  assert.notEqual(d.progress.artifactHash, a.progress.artifactHash)
})

// ── job 配置面：声明受检产物路径 ─────────────────────────────────────────────

const mod = await import(pluginHref)
const { normalizeJob, EXPLICIT_CLEAR_KEYS, applyExplicitClears } = mod

test('normalizeJob：artifactPaths 去重/去空/截断，null 清除，undefined 保持', () => {
  const trigger = { kind: 'interval', expression: '60s', timezone: 'local', everySeconds: 60 }
  const created = normalizeJob({ name: 'n', prompt: 'p', trigger, artifactPaths: [' a.md ', 'a.md', '', 'b.md'] })
  assert.deepEqual(created.artifactPaths, ['a.md', 'b.md'])

  const tooMany = normalizeJob({
    name: 'n', prompt: 'p', trigger, artifactPaths: Array.from({ length: 25 }, (_, i) => `f${i}.md`),
  })
  assert.equal(tooMany.artifactPaths.length, 20)

  const kept = normalizeJob({ name: 'n' }, { name: 'n', prompt: 'p', trigger, artifactPaths: ['old.md'] })
  assert.deepEqual(kept.artifactPaths, ['old.md'], 'undefined 保持旧声明')

  const cleared = normalizeJob({ name: 'n', artifactPaths: null }, { name: 'n', prompt: 'p', trigger, artifactPaths: ['old.md'] })
  assert.equal(cleared.artifactPaths, undefined, 'null 清除')
  assert.ok(EXPLICIT_CLEAR_KEYS.includes('artifactPaths'), 'null 清除必须进白名单表（否则 PATCH 回滚是空操作）')

  assert.throws(
    () => normalizeJob({ name: 'n', prompt: 'p', trigger, artifactPaths: 'a.md' }),
    /artifactPaths must be an array/,
  )

  const job = { ...created, artifactPaths: ['a.md', 'b.md'] }
  applyExplicitClears(job, { artifactPaths: null }, {})
  assert.equal('artifactPaths' in job, false, '显式清除必须真的删掉键')
})

// ── finish 事件端到端 ────────────────────────────────────────────────────────

function makeCfg(over = {}) {
  return {
    dataDir: mkdtempSync(join(tmpdir(), 'sched-progress-')),
    harnessDir: fixtureHarness,
    defaultWorkspace: tmpdir(),
    timeoutMs: 10_000,
    killGraceMs: 1_000,
    maxConcurrent: 2,
    tickMs: 500,
    maxConsecutiveFailures: 5,
    maxAttempts: 3,
    retryDelayMs: 5_000,
    catchUpPolicy: 'run_once',
    maxLatenessMs: 60_000,
    dispatchJitterMaxMs: 0,
    ...over,
  }
}

function makeCtx() {
  let handler
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    agents: { get: () => undefined, roots: () => [] },
    webServer: { register: (def) => { handler = def.handler; return () => {} } },
    effect: (fn) => { ctx._cleanup = fn() },
  }
  return { ctx, getHandler: () => handler }
}

let seq = 0
function makeJob(over = {}) {
  const id = over.id ?? `job-progress-${++seq}`
  return {
    id,
    name: `progress job ${id}`,
    prompt: 'do nothing',
    trigger: { kind: 'interval', expression: '60s', timezone: 'local', everySeconds: 60 },
    workspace: mkdtempSync(join(tmpdir(), 'sched-ws-')),
    enabled: true,
    state: 'scheduled',
    nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    lastRunAt: null,
    lastStatus: null,
    runCount: 0,
    consecutiveFailures: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  }
}

async function waitFor(fn, timeoutMs = 10_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error('waitFor: timeout')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

test('finish 事件：声明 artifactPaths 的作业写入 progress.artifactHash / actionHash', async (t) => {
  const { ctx } = makeCtx()
  const cfg = makeCfg()
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  const job = makeJob({ artifactPaths: ['report.md'] })
  writeFileSync(join(job.workspace, 'report.md'), 'report body\n')
  store.upsertJob(job)

  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'succeeded')
  assert.ok(done.progress, 'finish 行必须带 progress')
  const expected = computeProgress(job)
  assert.match(done.progress.artifactHash, /^[0-9a-f]{64}$/)
  assert.equal(done.progress.artifactHash, expected.progress.artifactHash, '台账里的哈希 = 按声明重算的哈希')
  assert.equal(done.progress.actionHash, computeActionHash(job), 'actionHash = 原始动作声明的哈希')
  assert.deepEqual(done.progress.artifactPaths, ['report.md'])
  assert.equal(done.progress.artifactBytes, 'report body\n'.length)
})

test('负向控制：未声明 artifactPaths 的作业不得写 progress（否则 watchdog 会把 unknown 洗成判词）', async (t) => {
  const { ctx } = makeCtx()
  const cfg = makeCfg()
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  const job = makeJob()
  store.upsertJob(job)

  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'succeeded')
  assert.equal('progress' in done, false, '未声明 ⇒ 无 progress 字段')
})

test('负向控制：声明了但产物缺失 ⇒ 有 progress 但没有 artifactHash（watchdog 必须判 unknown）', async (t) => {
  const { ctx } = makeCtx()
  const cfg = makeCfg()
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  const job = makeJob({ artifactPaths: ['never-written.md'] })
  store.upsertJob(job)

  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'succeeded')
  assert.equal(done.progress.artifactHash, undefined, '读不到产物就不得有 artifactHash')
  assert.deepEqual(done.progress.artifactProblems, ['never-written.md: unreadable(ENOENT)'])
})

test('finish 事件：日期占位符按本次触发时刻展开（接线不是摆设）', async (t) => {
  const { ctx } = makeCtx()
  const cfg = makeCfg()
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  const job = makeJob({ artifactPaths: ['report-{{DSH_SCHED_DATE_COMPACT}}.md'] })
  // 本次是定时触发（scheduledFor≈now），按宿主本地日期写产物
  const today = dateVars(new Date().toISOString())
  writeFileSync(join(job.workspace, `report-${today.dateCompact}.md`), 'today\n')
  store.upsertJob(job)

  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.ok(done.progress, 'finish 行必须带 progress（占位符展开后能读到产物）')
  assert.match(done.progress.artifactHash, /^[0-9a-f]{64}$/)
  assert.deepEqual(done.progress.artifactPaths, ['report-{{DSH_SCHED_DATE_COMPACT}}.md'])
})

// ── 离线夹具：真 watchdog + 真生产端产出 ───────────────────────────────────
//
// 判据 3 要求"真台账跑 watchdog 从 exit 2 变 0/1"。宿主未重载前 runs.jsonl 里不会有新
// 字段，所以这里用**生产端真算的哈希**造离线台账，喂给**真的** agent-progress-watchdog，
// 断言三个出口（0 progress / 1 stalled / 2 unknown）都能到。watchdog 不在本机时跳过
// （跨仓依赖，不能让插件 CI 因别的仓库缺失而红）。

function writeLedger(rows) {
  const file = join(mkdtempSync(join(tmpdir(), 'progress-ledger-')), 'runs.jsonl')
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return file
}

function runWatchdog(ledger) {
  return spawnSync(process.execPath, [WATCHDOG, '--ledger', ledger, '--json'], { encoding: 'utf8' })
}

function finishRow({ runKey, jobId, artifactHash, actionHash, extra = {} }) {
  return {
    evt: 'finish',
    jobId,
    runKey,
    triggerKind: 'scheduled',
    status: 'succeeded',
    attempt: 1,
    scheduledFor: new Date(Date.parse('2026-10-30T00:00:00Z') + Number(runKey.split('|')[1]) * 60_000).toISOString(),
    progress: artifactHash === null ? null : { artifactHash, actionHash },
    ...extra,
  }
}

test('离线夹具：真 watchdog 判 progress（产物在变）→ exit 0', (t) => {
  if (!existsSync(WATCHDOG)) return t.skip(`watchdog 不在本机：${WATCHDOG}`)
  const dir = mkdtempSync(join(tmpdir(), 'progress-fx-'))
  const file = join(dir, 'out.md')
  const job = { ...baseJob, workspace: dir, artifactPaths: ['out.md'] }
  const hashes = []
  for (const body of ['v1', 'v2', 'v3']) {
    writeFileSync(file, body)
    hashes.push(computeProgress(job).progress)
  }
  const rows = hashes.map((p, i) => finishRow({
    runKey: `job-fx|${i}`, jobId: 'job-fx', artifactHash: p.artifactHash, actionHash: p.actionHash,
  }))
  const res = runWatchdog(writeLedger(rows))
  assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`)
  assert.equal(JSON.parse(res.stdout).results[0].verdict, 'progress')
})

test('离线夹具负向控制：产物不变但动作在变 ⇒ stalled（exit 1），不是 progress', (t) => {
  if (!existsSync(WATCHDOG)) return t.skip(`watchdog 不在本机：${WATCHDOG}`)
  const dir = mkdtempSync(join(tmpdir(), 'progress-fx-'))
  const file = join(dir, 'out.md')
  writeFileSync(file, 'same')
  const hashes = []
  for (const prompt of ['a', 'b', 'c']) {
    hashes.push(computeProgress({ ...baseJob, prompt, workspace: dir, artifactPaths: ['out.md'] }).progress)
  }
  const rows = hashes.map((p, i) => finishRow({
    runKey: `job-fx|${i}`, jobId: 'job-fx', artifactHash: p.artifactHash, actionHash: p.actionHash,
  }))
  const res = runWatchdog(writeLedger(rows))
  assert.equal(res.status, 1, `stdout=${res.stdout} stderr=${res.stderr}`)
  assert.equal(JSON.parse(res.stdout).results[0].verdict, 'stalled')
})

test('离线夹具负向控制：没有声明/没有 progress 的行 ⇒ unknown（exit 2），不是 progress', (t) => {
  if (!existsSync(WATCHDOG)) return t.skip(`watchdog 不在本机：${WATCHDOG}`)
  const rows = [0, 1, 2].map((i) => finishRow({
    runKey: `job-fx|${i}`, jobId: 'job-fx', artifactHash: null, actionHash: null,
  }))
  const res = runWatchdog(writeLedger(rows))
  assert.equal(res.status, 2, `stdout=${res.stdout} stderr=${res.stderr}`)
  assert.equal(JSON.parse(res.stdout).results[0].verdict, 'unknown')
})
