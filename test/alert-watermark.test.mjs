import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

// Import via the profile symlink so peer deps resolve (see policy.test.mjs header).
const pluginHref = pathToFileURL(
  `${process.env.HOME}/.dsh/profiles/web/node_modules/dsh-scheduler/index.mjs`,
).href

const { alertWatermarkAfterPush } = await import(pluginHref)

test('delivered alert advances the watermark to the current failure streak', () => {
  assert.equal(alertWatermarkAfterPush({ delivered: true, consecutiveFailures: 2 }), 2)
  assert.equal(alertWatermarkAfterPush({ delivered: true, consecutiveFailures: 0 }), 0)
})

test('undelivered alert keeps the watermark (so the next failed run retries)', () => {
  // 2026-10-09-08-35 现场：出网中断 → feishu-push 返回 token_fetch_failed(exit 1)；
  // 旧实现在推送前就推进水位 ⇒ 告警永不重试。这里断言"未投递 ⇒ 保持原值"。
  assert.equal(alertWatermarkAfterPush({ delivered: false, consecutiveFailures: 2 }), null)
  assert.equal(alertWatermarkAfterPush({ delivered: undefined, consecutiveFailures: 2 }), null)
  assert.equal(alertWatermarkAfterPush({}), null)
  assert.equal(alertWatermarkAfterPush(null), null)
})

test('non-numeric failure counts never advance the watermark', () => {
  assert.equal(alertWatermarkAfterPush({ delivered: true, consecutiveFailures: 'two' }), null)
  assert.equal(alertWatermarkAfterPush({ delivered: true }), null)
})

test('kept watermark still satisfies the alert gate on the next failure', () => {
  // 调用点的门槛： (live.alertedFailures ?? 0) < updated.consecutiveFailures
  const alertedFailures = 1 // 上一次没发出去 ⇒ 水位停在 1
  const consecutiveFailures = 3
  assert.equal((alertedFailures ?? 0) < consecutiveFailures, true)
  // 成功投递后水位等于失败链长度 ⇒ 门槛不再满足（同一失败链不重复告警）
  const advanced = alertWatermarkAfterPush({ delivered: true, consecutiveFailures })
  assert.equal((advanced ?? 0) < consecutiveFailures, false)
})
