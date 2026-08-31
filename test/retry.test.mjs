import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

// Import via the profile symlink so peer deps resolve (see policy.test.mjs header).
const pluginHref = pathToFileURL(
  `${process.env.HOME}/.dsh/profiles/web/node_modules/dsh-scheduler/index.mjs`,
).href

const cfg = () => ({
  dataDir: '/tmp/x', harnessDir: '/tmp/h', defaultWorkspace: '/tmp',
  timeoutMs: 30 * 60_000, killGraceMs: 10_000, maxConcurrent: 2, tickMs: 60_000,
  maxConsecutiveFailures: 5, maxAttempts: 3, retryDelayMs: 60_000,
  catchUpPolicy: 'run_once', maxLatenessMs: 15 * 60_000,
})

test('isRetryableFailure: transient transport/network errors are retryable', async () => {
  const { isRetryableFailure } = await import(pluginHref)
  assert.equal(isRetryableFailure(''), true, 'empty output defaults to retryable')
  assert.equal(isRetryableFailure('dsh: TRANSPORT: DeepSeek API request to https://api.deepseek.com failed'), true)
  assert.equal(isRetryableFailure('Error: connect ECONNREFUSED 127.0.0.1:8080'), true)
  assert.equal(isRetryableFailure('timeout after 1800s'), true)
  assert.equal(isRetryableFailure('some random tool failure with exit code 1'), true)
  assert.equal(isRetryableFailure('HTTP 500 Internal Server Error from provider'), true)
  assert.equal(isRetryableFailure('rate limit exceeded, retry later'), true, '429 rate limit stays retryable')
})

test('isRetryableFailure: model-unavailable errors are retryable even when framed as 401/400', async () => {
  const { isRetryableFailure } = await import(pluginHref)
  // 2026-08-31 hermes: opencode-zen framed "model not supported" as AUTH 401 —
  // must stay retryable so the job's fallback chain (deepseek) gets attempt 2.
  assert.equal(isRetryableFailure('dsh: AUTH: 401: {"type":"ModelError","message":"Model hy3-free is not supported"}'), true)
  assert.equal(isRetryableFailure('INVALID_REQUEST: 400: {"type":"server_error","message":"Error from provider (Console): Upstream request failed: Model is unavailable."}'), true)
  assert.equal(isRetryableFailure('Model not found: gpt-99'), true)
  // plain 401s that are NOT model-availability still stay non-retryable
  assert.equal(isRetryableFailure('Error 401: invalid api key'), false)
  assert.equal(isRetryableFailure('authentication failed: unauthorized'), false)
})

test('shouldRetry: model-unavailable failure retries and reaches the fallback attempt', async () => {
  const { shouldRetry } = await import(pluginHref)
  const job = { id: 'j1' }
  const out = 'dsh: AUTH: 401: {"type":"ModelError","message":"Model hy3-free is not supported"}'
  assert.equal(shouldRetry(job, cfg(), 'failed', out, 1), true, 'attempt 1 model-unavailable -> retry with fallback model')
  assert.equal(shouldRetry(job, cfg(), 'failed', out, 2), true, 'attempt 2 still within max 3')
  assert.equal(shouldRetry(job, cfg(), 'failed', out, 3), false, 'attempt 3 == max 3 -> no retry')
})

test('isRetryableFailure: quota/billing/auth failures are NOT retryable', async () => {
  const { isRetryableFailure } = await import(pluginHref)
  assert.equal(isRetryableFailure('HTTP 402 Payment Required: insufficient balance'), false)
  assert.equal(isRetryableFailure('402: insufficient balance'), false)
  assert.equal(isRetryableFailure('your quota has been exhausted'), false)
  assert.equal(isRetryableFailure('insufficient credits'), false)
  assert.equal(isRetryableFailure('Error 401: invalid api key'), false)
  assert.equal(isRetryableFailure('authentication failed: unauthorized'), false)
  assert.equal(isRetryableFailure('403 Forbidden: billing issue on account'), false)
  assert.equal(isRetryableFailure('account suspended due to billing'), false)
})

test('shouldRetry: success never retries', async () => {
  const { shouldRetry } = await import(pluginHref)
  assert.equal(shouldRetry({}, cfg(), 'succeeded', 'anything', 1), false)
})

test('shouldRetry: caps at maxAttempts (global and job-level override)', async () => {
  const { shouldRetry } = await import(pluginHref)
  const job = { id: 'j1' }
  assert.equal(shouldRetry(job, cfg(), 'failed', 'transient', 1), true, 'attempt 1 < max 3')
  assert.equal(shouldRetry(job, cfg(), 'failed', 'transient', 2), true)
  assert.equal(shouldRetry(job, cfg(), 'failed', 'transient', 3), false, 'attempt 3 == max 3 -> no retry')
  const noRetry = { id: 'j2', maxAttempts: 1 }
  assert.equal(shouldRetry(noRetry, cfg(), 'failed', 'transient', 1), false, 'job-level maxAttempts=1 disables retry')
  const four = { id: 'j3', maxAttempts: 4 }
  assert.equal(shouldRetry(four, cfg(), 'failed', 'transient', 3), true, 'job-level maxAttempts=4 allows attempt 3')
})

test('shouldRetry: persistent failures never retry, even under budget', async () => {
  const { shouldRetry } = await import(pluginHref)
  assert.equal(shouldRetry({}, cfg(), 'failed', '402 insufficient balance', 1), false)
  assert.equal(shouldRetry({}, cfg(), 'failed', 'invalid api key', 1), false)
})

test('normalizeJob: accepts and clamps maxAttempts / retryDelayMs', async () => {
  const { normalizeJob } = await import(pluginHref)
  const base = { name: 't', prompt: 'p', trigger: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' } }
  const fields = normalizeJob({ ...base, maxAttempts: 4, retryDelayMs: 120_000 })
  assert.equal(fields.maxAttempts, 4)
  assert.equal(fields.retryDelayMs, 120_000)
  const clamped = normalizeJob({ ...base, maxAttempts: 99, retryDelayMs: 500 })
  assert.equal(clamped.maxAttempts, 10, 'clamped to max 10')
  assert.equal(clamped.retryDelayMs, 5_000, 'clamped to min 5s')
  const kept = normalizeJob({ name: 't2' }, fields)
  assert.equal(kept.maxAttempts, 4, 'existing value kept when absent')
  assert.equal(kept.retryDelayMs, 120_000)
  const cleared = normalizeJob({ maxAttempts: undefined, retryDelayMs: undefined }, fields)
  assert.equal(cleared.maxAttempts, 4, 'undefined input keeps existing')
})

test('resolveConfig: retry defaults present and overridable', async () => {
  const { resolveConfig } = await import(pluginHref)
  const c = resolveConfig({})
  assert.equal(c.maxAttempts, 3)
  assert.equal(c.retryDelayMs, 60_000)
  const over = resolveConfig({ maxAttempts: 2, retryDelayMs: 30_000 })
  assert.equal(over.maxAttempts, 2)
  assert.equal(over.retryDelayMs, 30_000)
})
