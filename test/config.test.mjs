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
