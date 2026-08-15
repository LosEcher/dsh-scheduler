import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

// Import via the profile symlink so peer `@deepseek-ai/schemastery` /
// `@deepseek-ai/dsh-llm` resolve (see config.test.mjs header).
const pluginHref = pathToFileURL(
  `${process.env.HOME}/.dsh/profiles/web/node_modules/dsh-scheduler/index.mjs`,
).href

const cfg = () => ({
  dataDir: '/tmp/x', harnessDir: '/tmp/h', defaultWorkspace: '/tmp',
  timeoutMs: 30 * 60_000, killGraceMs: 10_000, maxConcurrent: 2, tickMs: 60_000,
  maxConsecutiveFailures: 5, catchUpPolicy: 'run_once', maxLatenessMs: 15 * 60_000,
})

const intervalJob = (over = {}) => ({
  id: 'j1', trigger: { kind: 'interval', expression: '30m', everySeconds: 1800, timezone: 'local' },
  state: 'scheduled', enabled: true, consecutiveFailures: 0, runCount: 0,
  nextRunAt: new Date(Date.now() - 1000).toISOString(), ...over,
})

test('decideCatchUp: run_once always fires, however late', async () => {
  const { decideCatchUp } = await import(pluginHref)
  const now = Date.now()
  const job = { nextRunAt: new Date(now - 24 * 3600_000).toISOString() }
  assert.deepEqual(decideCatchUp(job, cfg(), now), { action: 'fire', latenessMs: 24 * 3600_000 })
})

test('decideCatchUp: skip drops occurrences beyond maxLatenessMs, fires within', async () => {
  const { decideCatchUp } = await import(pluginHref)
  const now = Date.now()
  const late1h = { nextRunAt: new Date(now - 3600_000).toISOString(), catchUpPolicy: 'skip' }
  assert.equal(decideCatchUp(late1h, cfg(), now).action, 'skip')
  const cfg2h = { ...cfg(), catchUpPolicy: 'skip', maxLatenessMs: 2 * 3600_000 }
  assert.equal(decideCatchUp(late1h, cfg2h, now).action, 'fire')
})

test('decideCatchUp: maxLatenessMs 0 means unlimited (never skip)', async () => {
  const { decideCatchUp } = await import(pluginHref)
  const now = Date.now()
  const job = { nextRunAt: new Date(now - 3600_000).toISOString(), catchUpPolicy: 'skip' }
  const unlimited = { ...cfg(), catchUpPolicy: 'skip', maxLatenessMs: 0 }
  assert.equal(decideCatchUp(job, unlimited, now).action, 'fire')
})

test('decideCatchUp: job-level policy overrides global', async () => {
  const { decideCatchUp } = await import(pluginHref)
  const now = Date.now()
  const job = { nextRunAt: new Date(now - 3600_000).toISOString(), catchUpPolicy: 'run_once' }
  const globalSkip = { ...cfg(), catchUpPolicy: 'skip', maxLatenessMs: 60_000 }
  assert.equal(decideCatchUp(job, globalSkip, now).action, 'fire')
})

test('applyRunResult: success resets failures and advances the schedule', async () => {
  const { applyRunResult } = await import(pluginHref)
  const completedAt = new Date().toISOString()
  const before = intervalJob({ consecutiveFailures: 3, runCount: 7 })
  const after = applyRunResult(before, { status: 'succeeded' }, cfg(), completedAt)
  assert.equal(after.consecutiveFailures, 0)
  assert.equal(after.runCount, 8)
  assert.equal(after.lastStatus, 'succeeded')
  assert.equal(after.state, 'scheduled')
  assert.equal(after.enabled, true)
  assert.ok(Date.parse(after.nextRunAt) > Date.now() + 30 * 60_000 - 5000)
})

test('applyRunResult: failure increments counter; trips breaker at threshold', async () => {
  const { applyRunResult } = await import(pluginHref)
  let job = intervalJob()
  for (let i = 1; i <= 4; i++) {
    job = applyRunResult(job, { status: 'failed', exitCode: 1 }, cfg(), new Date().toISOString())
    assert.equal(job.consecutiveFailures, i)
    assert.equal(job.state, 'scheduled', 'breaker not tripped before threshold')
  }
  job = applyRunResult(job, { status: 'failed', exitCode: 1 }, cfg(), new Date().toISOString())
  assert.equal(job.consecutiveFailures, 5)
  assert.equal(job.state, 'paused')
  assert.equal(job.enabled, false)
  assert.equal(job.pausedReason, 'max_consecutive_failures')
})

test('applyRunResult: one-shot completes after a run', async () => {
  const { applyRunResult } = await import(pluginHref)
  const once = {
    id: 'j2', trigger: { kind: 'once', expression: new Date(Date.now() - 1000).toISOString(), timezone: 'local' },
    state: 'scheduled', enabled: true, consecutiveFailures: 0, runCount: 0,
    nextRunAt: new Date(Date.now() - 1000).toISOString(),
  }
  const after = applyRunResult(once, { status: 'succeeded' }, cfg(), new Date().toISOString())
  assert.equal(after.state, 'completed')
  assert.equal(after.nextRunAt, null)
})

test('applyRunResult: paused job keeps its schedule untouched', async () => {
  const { applyRunResult } = await import(pluginHref)
  const paused = intervalJob({ state: 'paused', enabled: false, nextRunAt: '2026-12-31T00:00:00.000Z' })
  const after = applyRunResult(paused, { status: 'failed' }, cfg(), new Date().toISOString())
  assert.equal(after.state, 'paused')
  assert.equal(after.enabled, false)
  assert.equal(after.nextRunAt, '2026-12-31T00:00:00.000Z')
})

test('renderDelivery: includes status, trigger, duration and output head', async () => {
  const { renderDelivery } = await import(pluginHref)
  const text = renderDelivery(
    { name: 'CI 巡检' },
    { status: 'succeeded', scheduledFor: '2026-08-15T00:00:00.000Z', triggerKind: 'manual', durationMs: 1234, exitCode: 0, outputHead: '成功\n' },
  )
  assert.ok(text.includes('CI 巡检'))
  assert.ok(text.includes('执行完成'))
  assert.ok(text.includes('手动'))
  assert.ok(text.includes('1.2s'))
  assert.ok(text.includes('成功'))
})

test('normalizeJob: accepts deliverTo and catchUpPolicy, clears with null', async () => {
  const { normalizeJob } = await import(pluginHref)
  const fields = normalizeJob({
    name: 't', prompt: 'p', trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    deliverTo: { sessionId: '  sid-1  ' }, catchUpPolicy: 'skip',
  })
  assert.deepEqual(fields.deliverTo, { sessionId: 'sid-1' })
  assert.equal(fields.catchUpPolicy, 'skip')
  const cleared = normalizeJob({ deliverTo: null }, fields)
  assert.equal(cleared.deliverTo, undefined)
  const kept = normalizeJob({ name: 't2' }, fields)
  assert.deepEqual(kept.deliverTo, { sessionId: 'sid-1' })
})

test('resolveConfig: defaultWorkspace falls back to homedir, new fields defaulted', async () => {
  const { resolveConfig } = await import(pluginHref)
  const c = resolveConfig({})
  assert.equal(c.defaultWorkspace, homedir())
  assert.equal(c.killGraceMs, 10_000)
  assert.equal(c.maxConsecutiveFailures, 5)
  assert.equal(c.catchUpPolicy, 'run_once')
  assert.equal(c.maxLatenessMs, 15 * 60_000)
  const over = resolveConfig({ catchUpPolicy: 'skip', maxLatenessMs: 0, maxConsecutiveFailures: 3, killGraceMs: 5000 })
  assert.equal(over.catchUpPolicy, 'skip')
  assert.equal(over.maxLatenessMs, 0)
  assert.equal(over.maxConsecutiveFailures, 3)
  assert.equal(over.killGraceMs, 5000)
  const invalid = resolveConfig({ catchUpPolicy: 'bogus' })
  assert.equal(invalid.catchUpPolicy, 'run_once')
})
