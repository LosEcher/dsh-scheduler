// Execution-path tests for dsh-scheduler runJob/finish.
//
// These cover the paths that pure-function tests cannot: spawn headless →
// finish() bookkeeping → delivery → ledger + job-state advance, including the
// two failure modes behind the 2026-08-18 fire→crash→restart→refire loop:
//   - finish() must never take down the host (containment, A1)
//   - nextRunAt must advance at dispatch time so catch-up can't re-fire the
//     same occurrence after a crash (dispatch-time accounting, A2)
//   - a job whose run is in flight must not accumulate skipped records (A3)
//
// Runs against a fake harness CLI (test/fixtures/fake-harness) so no real
// agent/LLM is involved. Import via the profile symlink (see policy.test.mjs
// header) so peer deps resolve.
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
    dataDir: mkdtempSync(join(tmpdir(), 'sched-test-')),
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
    // Execution-path tests assert deterministic dispatch; jitter would delay
    // due occurrences by up to dispatchJitterMaxMs and time out waitFor().
    dispatchJitterMaxMs: 0,
    ...over,
  }
}

/** Minimal Cordis context; logger.info can be made to throw to exercise A1. */
function makeCtx({ crashOnSuccessLog = false } = {}) {
  let handler
  const ctx = {
    logger: {
      info: (msg) => {
        if (crashOnSuccessLog && String(msg).includes('succeeded for job')) {
          throw new Error('logger boom (simulated finish crash)')
        }
      },
      warn: () => {},
      error: () => {},
    },
    agents: { get: () => undefined, roots: () => [] },
    webServer: { register: (def) => { handler = def.handler; return () => {} } },
    effect: (fn) => { ctx._cleanup = fn() },
  }
  return { ctx, getHandler: () => handler }
}

let seq = 0
function makeJob(over = {}) {
  const id = over.id ?? `job-test-${++seq}`
  return {
    id,
    name: `test job ${id}`,
    prompt: 'do nothing',
    trigger: { kind: 'interval', expression: '60s', timezone: 'local', everySeconds: 60 },
    workspace: tmpdir(),
    enabled: true,
    state: 'scheduled',
    nextRunAt: new Date(Date.now() - 1_000).toISOString(), // due immediately
    lastRunAt: null,
    lastStatus: null,
    runCount: 0,
    consecutiveFailures: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  }
}

/** The ledger keeps both the in-flight (running) record and the final one for
 *  the same run id; count distinct run ids when asserting totals. */
function distinctRunIds(runs) {
  return new Set(runs.map((r) => r.id)).size
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

test('scheduled run succeeds → ledger succeeded, nextRunAt advanced, no crash', async (t) => {
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
  assert.equal(done.exitCode, 0)

  const live = store.getJob(job.id)
  assert.ok(live.nextRunAt && Date.parse(live.nextRunAt) > Date.now(), 'nextRunAt advanced beyond now')
  assert.equal(live.lastStatus, 'succeeded')
  assert.equal(live.runCount, 1)
  assert.equal(live.consecutiveFailures, 0)
})

test('A2 dispatch-time accounting: nextRunAt advanced while run in flight (crash-safe, interval stable)', async (t) => {
  const { ctx } = makeCtx()
  const mod = await import(pluginHref)
  const cfg = makeCfg()
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  process.env.FAKE_HANG_MS = '2000'
  const job = makeJob({ prompt: 'hang __HANG__ now' })
  store.upsertJob(job)

  // While the run is in flight, nextRunAt must already point at the next
  // occurrence — this is what makes crash-restart catch-up idempotent.
  await waitFor(() => store.listRuns(job.id).some((r) => r.evt === 'start'))
  const during = store.getJob(job.id)
  assert.ok(Date.parse(during.nextRunAt) > Date.now(), 'advanced at dispatch (before finish)')

  // After completion, the advanced value is kept (no double-advance, so an
  // interval job measures its period from dispatch, not completion).
  await waitFor(() => store.listRuns(job.id).some((r) => r.evt === 'finish'))
  assert.equal(store.getJob(job.id).nextRunAt, during.nextRunAt, 'value kept after finish')
  delete process.env.FAKE_HANG_MS
})

test('scheduled run fails → ledger failed with exitCode, retry scheduled (final status deferred)', async (t) => {
  const { ctx } = makeCtx()
  const mod = await import(pluginHref)
  const cfg = makeCfg()
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  const job = makeJob({ prompt: 'fail __FAIL__ now' })
  store.upsertJob(job)

  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'failed')
  assert.equal(done.exitCode, 3)
  // Attempt 1 failed transiently → the job carries a persisted retryState and
  // nextRunAt points at the retry instant; lastStatus stays null until the
  // final outcome (existing retry semantics).
  const live = store.getJob(job.id)
  assert.ok(live.retryState && live.retryState.attempt === 2, 'retryState persisted')
  assert.ok(Date.parse(live.nextRunAt) > Date.now(), 'nextRunAt points at retry instant')
  assert.equal(live.lastStatus, null)
})

test('A3 in-flight job produces no skipped spam and no double dispatch', async (t) => {
  const { ctx } = makeCtx()
  const mod = await import(pluginHref)
  const cfg = makeCfg()
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  process.env.FAKE_HANG_MS = '2500'
  const job = makeJob({ prompt: 'hang __HANG__ now' })
  store.upsertJob(job)

  await waitFor(() => store.listRuns(job.id).some((r) => r.evt === 'start'))
  // Several ticks pass while the run is in flight (tickMs=500); none may
  // append a skipped "already running" record or start a second run.
  await new Promise((r) => setTimeout(r, 1_800))
  const runs = store.listRuns(job.id)
  assert.equal(runs.filter((r) => r.evt === 'skipped').length, 0, 'no skipped spam')
  assert.equal(runs.filter((r) => r.evt === 'start').length, 1, 'exactly one run in flight')

  await waitFor(() => store.listRuns(job.id).some((r) => r.evt === 'finish'))
  assert.equal(distinctRunIds(store.listRuns(job.id)), 1, 'exactly one run id total')
  delete process.env.FAKE_HANG_MS
})

test('A1 finish() crash is contained: host survives, ledger written, no re-fire', async (t) => {
  const { ctx } = makeCtx({ crashOnSuccessLog: true })
  const mod = await import(pluginHref)
  const cfg = makeCfg()
  mod.apply(ctx, cfg) // must not throw
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  const job = makeJob()
  store.upsertJob(job)

  // The success log throws inside finish(); containment must still persist the
  // run record and the already-advanced nextRunAt, and keep the host alive.
  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'))
  assert.equal(done.status, 'succeeded', 'run record persisted despite logger crash')
  const live = store.getJob(job.id)
  assert.ok(Date.parse(live.nextRunAt) > Date.now(), 'advanced nextRunAt survives (no catch-up re-fire)')
})

test('retry: failed transient run schedules attempt 2, then gives up', async (t) => {
  const { ctx } = makeCtx()
  const mod = await import(pluginHref)
  const cfg = makeCfg({ maxAttempts: 2, retryDelayMs: 500 })
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  const job = makeJob({ prompt: 'fail __FAIL__ now', maxAttempts: 2 })
  store.upsertJob(job)

  // Attempt 1 fails → retryState persisted, nextRunAt points at the retry.
  const first = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish' && r.status === 'failed'))
  assert.equal(first.attempt, 1)
  const withRetry = await waitFor(() => store.getJob(job.id).retryState)
  assert.equal(withRetry.attempt, 2)

  // Attempt 2 fails → gives up (attempt == max), retryState cleared, final
  // status applied to the job.
  await waitFor(() => store.listRuns(job.id).filter((r) => r.evt === 'finish' && r.status === 'failed').length >= 2)
  const final = store.getJob(job.id)
  assert.equal(final.retryState, undefined)
  assert.equal(final.lastStatus, 'failed')
  // consecutiveFailures counts distinct failed occurrences (retries within one
  // occurrence fold into a single failure), so one failed occurrence → 1.
  assert.equal(final.consecutiveFailures, 1)
})

test('manual trigger does not consume the schedule (nextRunAt untouched)', async (t) => {
  const { ctx, getHandler } = makeCtx()
  const mod = await import(pluginHref)
  const cfg = makeCfg()
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  const future = new Date(Date.now() + 60_000).toISOString()
  const job = makeJob({ nextRunAt: future })
  store.upsertJob(job)

  const res = { writeHead: () => {}, end: () => {} }
  await getHandler()({ url: `/scheduler/jobs/${job.id}/trigger`, method: 'POST' }, res)
  await waitFor(() => store.listRuns(job.id).some((r) => r.status !== 'running'))
  const run = store.listRuns(job.id)[0]
  assert.equal(run.triggerKind, 'manual')
  assert.equal(store.getJob(job.id).nextRunAt, future, 'schedule not consumed by manual run')
})

test('dispatch jitter: due job waits trigger.jitterMaxMs before firing', async (t) => {
  const { ctx } = makeCtx()
  const mod = await import(pluginHref)
  const cfg = makeCfg() // dispatchJitterMaxMs: 0 — trigger-level jitter is fixed
  mod.apply(ctx, cfg)
  t.after(() => ctx._cleanup())
  const { Store } = await import('../lib/store.mjs')
  const store = new Store(cfg.dataDir)
  const job = makeJob({
    trigger: { kind: 'interval', expression: '60s', timezone: 'local', everySeconds: 60, jitterMaxMs: 1_200 },
  })
  store.upsertJob(job)

  // Inside the jitter window nothing may dispatch.
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(
    store.listRuns(job.id).filter((r) => r.evt === 'start').length,
    0,
    'no dispatch before jitter elapses',
  )

  // After the jitter elapses the run fires (fake harness settles in ms).
  const done = await waitFor(() => store.listRuns(job.id).find((r) => r.evt === 'finish'), 8_000)
  assert.equal(done.status, 'succeeded')
  assert.equal(store.getJob(job.id).consecutiveFailures, 0)
})
