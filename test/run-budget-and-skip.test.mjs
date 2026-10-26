// 执行路径测试：预算契约 + 失败归因 + 凭据预检的 skip 第三态。
//
// 这些行为只有跑真实的 runJob/finish 才能验证（纯函数测试覆盖不到），所以复用
// test/run-exec.test.mjs 的假 harness 形态。三条纪律贯穿本文件：
//   ① 每条断言都要能在"改动被撤掉"时变红（不是恒真的同义反复）；
//   ② 时间相关断言用**预算本身**作参照，不用绝对墙钟（机器慢不该红）；
//   ③ skip/未运行的判据是**台账里没有 start 事件**，不是"状态字段说不算失败"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pluginHref = pathToFileURL(
  `${process.env.HOME}/.dsh/profiles/web/node_modules/dsh-scheduler/index.mjs`,
).href
const fixtureHarness = new URL('./fixtures/fake-harness', import.meta.url).pathname

function makeCfg(over = {}) {
  return {
    dataDir: mkdtempSync(join(tmpdir(), 'sched-budget-')),
    harnessDir: fixtureHarness,
    defaultWorkspace: tmpdir(),
    timeoutMs: 10_000,
    killGraceMs: 1_000,
    maxConcurrent: 2,
    tickMs: 500,
    maxConsecutiveFailures: 5,
    alertOnConsecutiveFailures: 0, // 不推到真脚本；环境告警分支另有单测
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
  const id = over.id ?? `job-budget-${++seq}`
  return {
    id,
    name: `budget test ${id}`,
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

async function waitFor(fn, timeoutMs = 15_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error('waitFor: timeout')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

async function applyPlugin(t, cfg) {
  const { ctx } = makeCtx()
  const mod = await import(pluginHref)
  mod.apply(ctx, cfg)
  t.after(() => { if (ctx._cleanup) ctx._cleanup() })
  const { Store } = await import('../lib/store.mjs')
  return { store: new Store(cfg.dataDir), mod }
}

test('预算契约：子进程拿到 budget env，且 prompt 占位符被替换（不留字面量）', async (t) => {
  const cfg = makeCfg()
  const { store } = await applyPlugin(t, cfg)
  const job = makeJob({
    prompt: 'budget=__BUDGET_ENV__ seconds={{DSH_SCHED_BUDGET_S}} deadline={{DSH_SCHED_DEADLINE}} echo=__ECHO_PROMPT__',
  })
  store.upsertJob(job)
  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'succeeded', done.error)
  // 占位符必须被真实预算替换：默认 timeoutMs=10000 ⇒ 10 秒
  assert.match(done.outputHead, /seconds=10\b/)
  assert.doesNotMatch(done.outputHead, /\{\{DSH_SCHED_BUDGET_S\}\}/)
  assert.match(done.outputHead, /deadline=\d{4}-\d{2}-\d{2}T/)
})

test('作业级预算覆盖全局：timeoutMs=2000 的作业在 2s 被杀，而不是等到全局 10s', async (t) => {
  const cfg = makeCfg() // 全局 10s
  const { store } = await applyPlugin(t, cfg)
  process.env.FAKE_HANG_MS = '6000'
  const job = makeJob({ prompt: 'hang __HANG__ now', timeoutMs: 2_000, maxAttempts: 1 })
  store.upsertJob(job)
  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  delete process.env.FAKE_HANG_MS
  assert.equal(done.status, 'failed')
  assert.equal(done.failureKind, 'timeout', '超时必须归因为 timeout')
  // 判据用预算本身：被杀时刻必须接近作业预算而不是全局超时
  assert.ok(done.durationMs >= 1_800, `too early: ${done.durationMs}ms`)
  assert.ok(done.durationMs < 5_000, `ran past the job budget: ${done.durationMs}ms`)
  assert.match(done.error, /timeout after 2s/)
})

test('软预算事件：跨过 80% 预算时落 evt:budget（事后能回答"是不是老贴着上限跑"）', async (t) => {
  const cfg = makeCfg()
  const { store } = await applyPlugin(t, cfg)
  process.env.FAKE_HANG_MS = '6000'
  const job = makeJob({ prompt: 'hang __HANG__ now', timeoutMs: 2_000, maxAttempts: 1 })
  store.upsertJob(job)
  await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  delete process.env.FAKE_HANG_MS
  // 软预算事件是 side event：折叠视图里不作为独立 run 出现，而是挂在那个 run 上
  const done = store.listRuns(job.id).find((r) => r.evt === 'finish')
  assert.ok(done.budgetSoft, 'expected the run to carry a budget soft event')
  assert.equal(done.budgetSoft.budgetMs, 2_000)
  assert.ok(done.budgetSoft.deadlineAt && Date.parse(done.budgetSoft.deadlineAt) > 0)
})

test('非零退出必须带根因与归因：error="exit code 3" + failureKind=exit_nonzero', async (t) => {
  const cfg = makeCfg()
  const { store } = await applyPlugin(t, cfg)
  const job = makeJob({ prompt: 'fail __FAIL__ now', maxAttempts: 1 })
  store.upsertJob(job)
  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'failed')
  assert.equal(done.failureKind, 'exit_nonzero')
  // 2026-10-26 之前这里 error 为空，台账只剩 "[attempt N/N] ..." ⇒ 根因丢失
  assert.match(done.error, /exit code 3/)
})

test('缺凭据失败：归因 missing_credential，不重试，且不计入连续失败链', async (t) => {
  const cfg = makeCfg()
  const { store } = await applyPlugin(t, cfg)
  const job = makeJob({ prompt: 'auth __CREDMISS__ now' }) // maxAttempts 默认 3
  store.upsertJob(job)
  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'failed', '状态仍要诚实：确实跑过且失败了')
  assert.equal(done.failureKind, 'missing_credential')
  assert.equal(done.environmentFailure, true)
  const live = store.getJob(job.id)
  assert.equal(live.retryState, undefined, '环境类失败不得重试（重试造不出凭据）')
  assert.equal(live.consecutiveFailures, 0, '环境类失败不得计入作业失败链')
  assert.equal(live.lastFailureKind, 'missing_credential', '归因要能被 status 读到')
  // 它不是被熔断的作业：enabled 仍为 true、state 未 paused
  assert.equal(live.enabled, true)
  assert.notEqual(live.state, 'paused')
})

test('凭据预检：白名单 route 缺凭据 ⇒ skipped 且**没有起子进程**（台账无 start）', async (t) => {
  const cfg = makeCfg()
  const { store } = await applyPlugin(t, cfg)
  // los 是白名单 route，本测试进程里没有 LOS_AUTH_TOKEN（显式断言前提，避免环境假绿）
  assert.equal(process.env.LOS_AUTH_TOKEN, undefined, 'precondition: LOS_AUTH_TOKEN must be unset')
  const job = makeJob({ prompt: 'should never run', model: { provider: 'los', model: 'kimi' } })
  store.upsertJob(job)
  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'skipped')
  assert.equal(done.skippedReason, 'missing_credential')
  assert.equal(done.exitCode, undefined, '子进程从未启动 ⇒ 不应有退出码')
  assert.equal(done.outputHead, '', '子进程从未启动 ⇒ 不应有任何输出')
  assert.ok(done.durationMs < 1_000, `skip 必须"立即"结束（实测 ${done.durationMs}ms）`)
  assert.equal(done.environmentFailure, true)
  const live = store.getJob(job.id)
  assert.equal(live.lastStatus, 'skipped')
  assert.equal(live.consecutiveFailures, 0)
  assert.equal(live.lastFailureKind, 'missing_credential')
})

test('负向控制：不认识的 provider 不会被误判缺凭据（照常运行）', async (t) => {
  const cfg = makeCfg()
  const { store } = await applyPlugin(t, cfg)
  const job = makeJob({ prompt: 'echo __ECHO_PROMPT__', model: { provider: 'my-own-gateway', model: 'x' } })
  store.upsertJob(job)
  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'succeeded', '不认识的 route 必须照常跑，不能因"没找到 KEY"跳过')
})
