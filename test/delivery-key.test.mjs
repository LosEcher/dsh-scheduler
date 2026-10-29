/**
 * dsh-scheduler — test/delivery-key.test.mjs
 * computeDeliveryKey 的时间基准：必须用 scheduledFor（事件时刻）而不是 attempt 墙钟。
 *
 * 背景（2026-10-29 实证）：cd7 同一个 runKey（= jobId|scheduledFor）下，
 * attempt1 渲染出 `…-20261028-08`、attempt2/3 渲染出 `…-20261028-09` —— 跨小时重试换键，
 * 幂等失效、交付越界守卫指向错位。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

// 与 test/push-delivery.test.mjs 同一取法：从 profile 的 link 安装路径导入，
// 这样插件的依赖（@deepseek-ai/schemastery 等）能从 profile/node_modules 解析。
// 需要 `node --preserve-symlinks`（npm test 已带该标志）。
const pluginHref = pathToFileURL(
  `${process.env.HOME}/.dsh/profiles/web/node_modules/dsh-scheduler/index.mjs`,
).href
const mod = await import(pluginHref)

const job = { id: 'job-cd7', deliveryKey: 'feed-digest-{{jobId}}-{{date}}-{{hour}}' }
const scheduledFor = '2026-10-28T00:35:00.000Z' // Asia/Shanghai → 2026-10-28 08:35
const runKey = `job-cd7|${scheduledFor}`

test('同一 scheduledFor、不同 attempt 墙钟 ⇒ 交付键相同（跨小时重试不换键）', () => {
  const a = mod.computeDeliveryKey(job, runKey, scheduledFor, new Date('2026-10-28T00:36:10Z'))
  const b = mod.computeDeliveryKey(job, runKey, scheduledFor, new Date('2026-10-28T01:40:00Z'))
  assert.equal(a, b)
  assert.equal(a, 'feed-digest-job-cd7-20261028-08')
})

test('负向控制：scheduledFor 缺失时退回 now（手动补跑仍能出键，且键随 now 变）', () => {
  const a = mod.computeDeliveryKey(job, runKey, undefined, new Date('2026-10-28T00:36:10Z'))
  const b = mod.computeDeliveryKey(job, runKey, undefined, new Date('2026-10-28T01:40:00Z'))
  assert.match(a, /^feed-digest-job-cd7-\d{8}-\d{2}$/)
  assert.notEqual(a, b, '没有 scheduledFor 时只能按 now，这是预期降级')
})

test('负向控制：scheduledFor 不可解析 ⇒ 退回 now，不抛错', () => {
  const a = mod.computeDeliveryKey(job, runKey, 'not-a-date', new Date('2026-10-28T01:40:00Z'))
  assert.match(a, /^feed-digest-job-cd7-\d{8}-\d{2}$/)
})

test('未配 deliveryKey ⇒ 返回 runKey（旧作业零影响）', () => {
  assert.equal(mod.computeDeliveryKey({ id: 'x' }, 'run-key-1', scheduledFor), 'run-key-1')
})

test('{{scheduledFor}} 原样注入，{{slot}} 同样以事件时刻渲染', () => {
  const j = { id: 'j2', deliveryKey: 'k-{{slot}}-{{scheduledFor}}' }
  const out = mod.computeDeliveryKey(j, runKey, scheduledFor, new Date('2026-10-28T09:00:00Z'))
  assert.ok(out.startsWith('k-0835-'), out)
  assert.ok(out.endsWith(scheduledFor), out)
})
