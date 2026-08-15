import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

// Import via the profile symlink so peer `@deepseek-ai/schemastery` resolves.
// Direct `../index.mjs` realpaths out of the profile and cannot see the host.
const pluginHref = pathToFileURL(
  `${process.env.HOME}/.dsh/profiles/web/node_modules/dsh-scheduler/index.mjs`,
).href

test('empty config resolves string defaults, not factory functions', async () => {
  const { Config } = await import(pluginHref)
  const cfg = Config({})
  assert.equal(typeof cfg.dataDir, 'string')
  assert.equal(typeof cfg.harnessDir, 'string')
  assert.equal(typeof cfg.defaultWorkspace, 'string')
  assert.ok(cfg.dataDir.endsWith('/storages/dsh-scheduler'))
  assert.equal(
    cfg.dataDir,
    `${process.env.DSH_HOME ?? `${homedir()}/.dsh`}/storages/dsh-scheduler`,
  )
  assert.equal(typeof cfg.timeoutMs, 'number')
})
