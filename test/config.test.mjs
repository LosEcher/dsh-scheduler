import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

// Import via the profile symlink so peer `@deepseek-ai/schemastery` resolves.
// Direct `../index.mjs` realpaths out of the profile and cannot see the host.
const pluginHref = pathToFileURL(
  `${process.env.HOME}/.dsh/profiles/web/node_modules/dsh-scheduler/index.mjs`,
).href

// Regression (2026-08-15): schemastery `.default()` stores its argument
// AS-IS. v0.1 passed env-derived factory functions → the loader validated
// against the function objects and the whole web plugin tree failed to boot.
// Two-layer contract pinned here:
//   1. Schema with `config: {}` must never produce a function for a field.
//   2. Runtime resolution (resolveConfig) must produce concrete strings.
test('Config({}) yields no factory-function defaults', async () => {
  const { Config } = await import(pluginHref)
  const cfg = Config({})
  for (const key of ['dataDir', 'harnessDir', 'defaultWorkspace', 'timeoutMs', 'maxConcurrent', 'tickMs']) {
    assert.notEqual(typeof cfg[key], 'function', `${key} must not be a factory function`)
  }
})

test('resolveConfig({}) fills env-derived string defaults', async () => {
  const { resolveConfig } = await import(pluginHref)
  const cfg = resolveConfig({})
  assert.equal(typeof cfg.dataDir, 'string')
  // harnessDir is optional now: resolveCliEntry() auto-discovers the dsh CLI
  // (explicit config/env → ~/.dsh/source/current → profile install → error).
  assert.ok(cfg.harnessDir === undefined || typeof cfg.harnessDir === 'string')
  assert.equal(typeof cfg.defaultWorkspace, 'string')
  assert.ok(cfg.dataDir.endsWith('/storages/dsh-scheduler'))
  assert.equal(
    cfg.dataDir,
    `${process.env.DSH_HOME ?? `${homedir()}/.dsh`}/storages/dsh-scheduler`,
  )
  assert.equal(typeof cfg.timeoutMs, 'number')
  assert.equal(typeof cfg.maxConcurrent, 'number')
  assert.equal(typeof cfg.tickMs, 'number')
})

test('explicit config wins over env-derived defaults', async () => {
  const { resolveConfig } = await import(pluginHref)
  const cfg = resolveConfig({ dataDir: '/tmp/x', harnessDir: '/tmp/h', timeoutMs: 60_000 })
  assert.equal(cfg.dataDir, '/tmp/x')
  assert.equal(cfg.harnessDir, '/tmp/h')
  assert.equal(cfg.timeoutMs, 60_000)
})

test('dispatchJitterMaxMs: default 180s, explicit wins, 0 disables', async () => {
  const { resolveConfig } = await import(pluginHref)
  assert.equal(resolveConfig({}).dispatchJitterMaxMs, 180_000)
  assert.equal(resolveConfig({ dispatchJitterMaxMs: 0 }).dispatchJitterMaxMs, 0)
  assert.equal(resolveConfig({ dispatchJitterMaxMs: 45_000 }).dispatchJitterMaxMs, 45_000)
})

test('normalizeTrigger: jitterMaxMs accepted, invalid rejected, absent omitted', async () => {
  const { normalizeTrigger } = await import(pluginHref)
  const withJitter = normalizeTrigger({ kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai', jitterMaxMs: 120_000 })
  assert.equal(withJitter.jitterMaxMs, 120_000)
  const zero = normalizeTrigger({ kind: 'interval', expression: '1h', jitterMaxMs: 0 })
  assert.equal(zero.jitterMaxMs, 0)
  const absent = normalizeTrigger({ kind: 'cron', expression: '0 9 * * *' })
  assert.equal('jitterMaxMs' in absent, false)
  assert.throws(() => normalizeTrigger({ kind: 'cron', expression: '0 9 * * *', jitterMaxMs: -5 }), /jitterMaxMs/)
  assert.throws(() => normalizeTrigger({ kind: 'cron', expression: '0 9 * * *', jitterMaxMs: 'x' }), /jitterMaxMs/)
})

test('normalizeJob: model object accepted, invalid rejected, null clears', async () => {
  const { normalizeJob } = await import(pluginHref)
  const base = { name: 'x', prompt: 'p', trigger: { kind: 'cron', expression: '0 9 * * *' } }
  const withModel = normalizeJob({ ...base, model: { provider: 'opencode-zen', model: 'deepseek-v4-flash-free', reasoningEffort: 'high' } })
  assert.deepEqual(withModel.model, { provider: 'opencode-zen', model: 'deepseek-v4-flash-free', reasoningEffort: 'high' })
  const minimal = normalizeJob({ ...base, model: { provider: 'p', model: 'm' } })
  assert.deepEqual(minimal.model, { provider: 'p', model: 'm' })
  assert.throws(() => normalizeJob({ ...base, model: { provider: '' } }), /model/)
  assert.throws(() => normalizeJob({ ...base, model: 'deepseek' }), /model must be an object/)
  const cleared = normalizeJob({ ...base, model: null })
  assert.equal('model' in cleared, false)
})

test('normalizeJob: null clears an existing model (not resurrected by spread)', async () => {
  const { normalizeJob } = await import(pluginHref)
  const existing = {
    name: 'x', prompt: 'p',
    trigger: { kind: 'cron', expression: '0 9 * * *' },
    model: { provider: 'nvidia-nim', model: 'nvidia/llama-3.3-nemotron-super-49b-v1.5' },
  }
  const cleared = normalizeJob({ model: null }, existing)
  assert.equal('model' in cleared, false, 'normalizeJob omits a cleared model')
  // Simulate routeUpdateJob's {...existing, ...fields} merge: without the
  // explicit delete, the cleared value would be resurrected from existing.
  const merged = { ...existing, ...cleared }
  assert.equal('model' in merged, true, 'spread resurrects existing.model (route must delete)')
})
