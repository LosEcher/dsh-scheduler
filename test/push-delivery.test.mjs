// Push-delivery tests for dsh-scheduler (2026-10-03 重复推送复盘).
//
// 背景：scheduler 的 assertCmd 只验「报告文件存在/非空/新鲜」，完全不验
// 「这次触发推了几条」。于是 30 天里 7 起重复推送（一次触发推 2-4 条）全在
// 盲区里：6 起是同一 run 内模型因「摘要 >500 字」自我纠正重发，1 起是超时重试
// 换了 key 重发。本次改动把两件事钉住：
//
//   A. runKey 注入：$DSH_SCHED_RUN_KEY = <jobId>|<scheduledFor>，**attempt 不进 key**
//      —— 一次触发的所有 attempt 共用一个幂等键，push 脚本（claim→send→commit）
//      据此拒绝第二次发送。
//   B. 交付入台账：scheduler 从 push 脚本的 .sent **派生** push 事实写进 runs.jsonl
//      finish 行，并在 /plugins/dsh-scheduler/status 暴露；notify.require=true 时
//      交付缺失即判失败（可选门禁，默认关）。
//
// 本文件对每一步都带负向控制：key 必须真的送到子进程、"缺失"必须能被判出来、
// require 门禁不能把已投递的运行误判成失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pluginHref = pathToFileURL(
  `${process.env.HOME}/.dsh/profiles/web/node_modules/dsh-scheduler/index.mjs`,
).href
const fixtureHarness = new URL('./fixtures/fake-harness', import.meta.url).pathname

function makeCfg(over = {}) {
  return {
    dataDir: mkdtempSync(join(tmpdir(), 'sched-push-')),
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
    deliveryStateDir: mkdtempSync(join(tmpdir(), 'sched-push-state-')),
    ...over,
  }
}

/** ctx that keeps every registered route addressable by path. */
function makeCtx() {
  const routes = new Map()
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    agents: { get: () => undefined, roots: () => [] },
    webServer: { register: (def) => { routes.set(def.path, def.handler); return () => {} } },
    effect: (fn) => { ctx._cleanup = fn() },
  }
  return { ctx, routes }
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(code) { this.statusCode = code },
    end(payload) { this.body = payload },
  }
}

let seq = 0
function makeJob(over = {}) {
  const id = over.id ?? `job-push-${++seq}`
  return {
    id,
    name: `push test job ${id}`,
    prompt: 'do nothing',
    trigger: { kind: 'interval', expression: '60s', timezone: 'local', everySeconds: 60 },
    workspace: tmpdir(),
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

// ── 纯函数契约 ──────────────────────────────────────────────────────────────

test('computeRunKey: attempt 不影响 key（重试必须复用同一个幂等键）', async () => {
  const mod = await import(pluginHref)
  const scheduledFor = '2026-10-03T05:35:00.000Z'
  const k1 = mod.computeRunKey('job-63261034-cd7', scheduledFor)
  const k2 = mod.computeRunKey('job-63261034-cd7', scheduledFor)
  const other = mod.computeRunKey('job-63261034-cd7', '2026-10-03T13:35:00.000Z')
  assert.equal(k1, k2, 'same trigger → same key')
  assert.equal(k1, 'job-63261034-cd7|2026-10-03T05:35:00.000Z')
  assert.notEqual(k1, other, 'different occurrence → different key')
})

test('deliveryKeyHash 与 push 脚本的 bash key_hash 逐位一致（跨语言契约）', async (t) => {
  const mod = await import(pluginHref)
  const key = 'job-63261034-cd7|2026-10-03T05:35:00.000Z'
  let bash
  try {
    bash = execSync(
      `printf '%s' ${JSON.stringify(key)} | shasum -a 256 | cut -c1-16`,
      { shell: '/bin/bash' },
    ).toString().trim()
  } catch {
    t.skip('shasum unavailable')
    return
  }
  assert.equal(mod.deliveryKeyHash(key), bash, 'Node 侧派生 hash 必须等于脚本写文件用的 hash')
})

test('readDeliveryRecord: 读到真 .sent；缺失/损坏一律 null（不抛）', async () => {
  const mod = await import(pluginHref)
  const dir = mkdtempSync(join(tmpdir(), 'sched-push-read-'))
  const key = 'job-x|2026-10-03T00:00:00.000Z'
  const hash = mod.deliveryKeyHash(key)

  assert.equal(mod.readDeliveryRecord(dir, key), null, 'missing → null')
  assert.equal(mod.readDeliveryRecord('', key), null)
  assert.equal(mod.readDeliveryRecord(dir, ''), null)

  writeFileSync(join(dir, `${hash}.sent`), '{not json', 'utf8')
  assert.equal(mod.readDeliveryRecord(dir, key), null, 'corrupt → null（不抛）')

  writeFileSync(join(dir, `${hash}.sent`), JSON.stringify({ key, messageId: 'om_a', sentAt: 'S' }), 'utf8')
  const rec = mod.readDeliveryRecord(dir, key)
  assert.equal(rec.messageId, 'om_a')
  assert.equal(rec.status, undefined, 'raw record 不带 status（由 finish 折叠）')
})

// ── 执行路径：runKey 注入 + 交付派生 ────────────────────────────────────────

test('runKey 注入子进程：缺任一 run-context env 则 fake harness 报错（负向控制）', async (t) => {
  const { ctx } = makeCtx()
  const mod = await import(pluginHref)
  const cfg = makeCfg()
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  const job = makeJob({ prompt: '__NOENV__ check' })
  store.upsertJob(job)

  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'succeeded', 'env 齐备时 fake harness exit 0')
  assert.ok(done.runKey, 'start/finish 台账都带 runKey')
  assert.equal(done.runKey, mod.computeRunKey(job.id, done.scheduledFor))
})

test('notify job + 推送成功 → 台账 push=delivered（含 messageId），状态路由可见', async (t) => {
  const { ctx, routes } = makeCtx()
  const mod = await import(pluginHref)
  const cfg = makeCfg()
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  const job = makeJob({ prompt: '__PUSH__ --key "{{DSH_SCHED_RUN_KEY}}" --max-chars 500 推一条', notify: { channel: 'feishu' } })
  store.upsertJob(job)

  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'succeeded')
  assert.ok(done.push, 'finish 行必须带 push 字段')
  assert.equal(done.push.status, 'delivered')
  assert.equal(done.push.messageId, 'om_fake_test')
  assert.equal(done.push.channel, 'feishu')
  assert.equal(done.push.key, done.runKey)

  const res = makeRes()
  routes.get('/plugins/dsh-scheduler/status')({}, res)
  const body = JSON.parse(res.body)
  assert.equal(body.counts.notifyJobs, 1)
  assert.equal(body.counts.pushMissing, 0, '已投递 → 不计入缺失')
  assert.equal(body.detail.lastPush[job.id].status, 'delivered')
  assert.equal(body.detail.deliveryStateDir, cfg.deliveryStateDir)
})

test('notify job + 未推送 → push=missing（默认不判失败，只记录）', async (t) => {
  const { ctx, routes } = makeCtx()
  const mod = await import(pluginHref)
  const cfg = makeCfg()
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  // prompt 不推送（无 __PUSH__）→ .sent 永远不会出现
  const job = makeJob({ notify: { channel: 'feishu' } })
  store.upsertJob(job)

  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'succeeded', 'require 未开 ⇒ 缺失只记录不判失败')
  assert.equal(done.push.status, 'missing')
  assert.equal(done.push.key, done.runKey)

  const res = makeRes()
  routes.get('/plugins/dsh-scheduler/status')({}, res)
  const body = JSON.parse(res.body)
  assert.equal(body.counts.pushMissing, 1)
})

test('notify.require=true + 未推送 → 判失败且可重试（负向控制的另一面：已投递不得误判）', async (t) => {
  const { ctx } = makeCtx()
  const mod = await import(pluginHref)
  const cfg = makeCfg({ maxAttempts: 2, retryDelayMs: 500 })
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  const job = makeJob({ notify: { channel: 'feishu', require: true }, maxAttempts: 2 })
  store.upsertJob(job)

  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'failed')
  assert.equal(done.deliveryMissing, true)
  assert.match(done.error, /delivery missing/)
  assert.ok(store.getJob(job.id).retryState, '交付缺失是可恢复的 → 允许重试')
})

test('notify.require=true + 已推送 → 仍判成功（门禁不得吞掉正常投递）', async (t) => {
  const { ctx } = makeCtx()
  const mod = await import(pluginHref)
  const cfg = makeCfg()
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  const job = makeJob({ prompt: '__PUSH__ --key "{{DSH_SCHED_RUN_KEY}}" --max-chars 500 推一条', notify: { channel: 'feishu', require: true } })
  store.upsertJob(job)

  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'succeeded')
  assert.equal(done.push.status, 'delivered')
  assert.equal(store.getJob(job.id).consecutiveFailures, 0)
})

test('三态：合法静默（--skip 写 .skipped）→ push=skipped，且 require 下仍判成功', async (t) => {
  const { ctx, routes } = makeCtx()
  const mod = await import(pluginHref)
  const cfg = makeCfg()
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  // 真实场景：feed job 当日故障已通知过 ⇒ 有意静默（调 --skip 记账），不是漏发。
  const job = makeJob({
    prompt: '__SKIP__ --key "{{DSH_SCHED_RUN_KEY}}" 当日故障已通知',
    notify: { channel: 'feishu', require: true },
  })
  store.upsertJob(job)

  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'succeeded', '合法静默不得被判失败（否则 require 永远开不起来）')
  assert.equal(done.push.status, 'skipped')
  assert.equal(done.push.key, done.runKey)
  assert.equal(store.getJob(job.id).consecutiveFailures, 0)

  const res = makeRes()
  routes.get('/plugins/dsh-scheduler/status')({}, res)
  const body = JSON.parse(res.body)
  assert.equal(body.counts.pushSkipped, 1)
  assert.equal(body.counts.pushMissing, 0, 'skipped 不得混进 missing 计数')
})

test('三态：delivered 优先于 skipped（已真投递的 key 不会被 --skip 覆盖）', async (t) => {
  const { ctx } = makeCtx()
  const mod = await import(pluginHref)
  const cfg = makeCfg()
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  const job = makeJob({ notify: { channel: 'feishu' } })
  store.upsertJob(job)
  // 预置同 key 的 .sent（模拟脚本侧已投递）
  const key = mod.computeRunKey(job.id, job.nextRunAt)
  const fs = await import('node:fs')
  fs.writeFileSync(
    `${cfg.deliveryStateDir}/${mod.deliveryKeyHash(key)}.sent`,
    JSON.stringify({ key, messageId: 'om_pre', sentAt: 'T' }),
  )
  fs.writeFileSync(
    `${cfg.deliveryStateDir}/${mod.deliveryKeyHash(key)}.skipped`,
    JSON.stringify({ key, reason: 'stale' }),
  )

  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.push.status, 'delivered', '.sent 存在时必须优先判 delivered')
})

test('renderPrompt：占位符全部替换；无占位符或 runKey 为空时原样返回', async () => {
  const mod = await import(pluginHref)
  const key = 'job-x|2026-10-03T05:35:00.000Z'
  assert.equal(mod.renderPrompt('--key "{{DSH_SCHED_RUN_KEY}}"', key), `--key "${key}"`)
  assert.equal(
    mod.renderPrompt('a {{DSH_SCHED_RUN_KEY}} b {{DSH_SCHED_RUN_KEY}}', key),
    `a ${key} b ${key}`,
    '多处占位符都要替换',
  )
  assert.equal(mod.renderPrompt('无占位符的旧 job', key), '无占位符的旧 job')
  // 负向控制：runKey 缺失时不能把占位符留成字面量——那会让所有 job 共用一个假 key
  // 而互相 dedup 掉。
  assert.equal(mod.renderPrompt('--key "{{DSH_SCHED_RUN_KEY}}"', ''), '--key "{{DSH_SCHED_RUN_KEY}}"')
  assert.ok(!mod.renderPrompt('--key "{{DSH_SCHED_RUN_KEY}}"', '').includes('job-'))
})

test('端到端：spawn 给 agent 的 prompt 里占位符已换成 runKey（bash 工具不继承 env，这是唯一通道）', async (t) => {
  const { ctx } = makeCtx()
  const mod = await import(pluginHref)
  const cfg = makeCfg()
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  const job = makeJob({ prompt: '__ECHO_PROMPT__ --key "{{DSH_SCHED_RUN_KEY}}" --max-chars 500' })
  store.upsertJob(job)

  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'succeeded')
  const m = /PROMPT=.*--key "([^"]+)"/.exec(done.outputHead ?? '')
  assert.ok(m, `prompt 回显里应有 --key 实参：${(done.outputHead ?? '').slice(0, 200)}`)
  assert.equal(m[1], done.runKey, 'agent 收到的 key 必须是本次触发的 runKey')
  assert.ok(!(done.outputHead ?? '').includes('{{DSH_SCHED_RUN_KEY}}'), '占位符不得残留成字面量')
})

test('非 notify job 不产生 push 字段（不打扰既有 jobs）', async (t) => {
  const { ctx } = makeCtx()
  const mod = await import(pluginHref)
  const cfg = makeCfg()
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  const job = makeJob()
  store.upsertJob(job)

  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'succeeded')
  assert.equal(done.push, undefined, '未声明 notify ⇒ 交付链不参与')
})
