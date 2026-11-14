// 渠道依赖门禁（L2-4）的判据测试（纯函数 + 临时注册表，无宿主依赖）。
//
// 这个门禁的错法只有两种，都很贵：
//   · 渠道明明不可用却放行 ⇒ run 白跑一遍、烧掉预算，台账只剩 delivery_missing（把
//     "渠道关了"说成"任务坏了"）；
//   · 健康面读不到时**当作不可用**与**当作可用**都不对：前者会让所有渠道任务静默停摆、
//     后者会让它们全部跑空。所以这里用两个不同 reason 把两种事实分开，且都要能被筛出来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CHANNEL_OK_STATES, CHANNEL_GATE_REASONS, channelRegistryPath, readChannelRegistry,
  requiredChannelsFor, evaluateChannelGate,
} from '../lib/channel-gate.mjs'
import { FAILURE_KINDS, ENVIRONMENT_KINDS, isEnvironmentFailure, describeFailureKind } from '../lib/failure-class.mjs'

const reg = (channels) => ({ ok: true, registry: { version: 1, asOf: new Date().toISOString(), channels } })
const entry = (id, side, state, evidence = 'test') => ({ id, side, state, evidence })

test('需求派生：显式声明 ∪ notify.require 的 channel（require=false 不构成依赖）', () => {
  assert.deepEqual(requiredChannelsFor({}), [])
  assert.deepEqual(requiredChannelsFor({ notify: { channel: 'feishu', require: true } }), ['feishu'])
  assert.deepEqual(requiredChannelsFor({ notify: { channel: 'feishu', require: false } }), [],
    '只跟踪不强制 ⇒ 渠道关了也允许跑完，不能因此 skip')
  assert.deepEqual(
    requiredChannelsFor({ requiresChannels: ['wechat'], notify: { channel: 'feishu', require: true } }),
    ['feishu', 'wechat'],
    '显式 + 派生要合并去重（同一事实不能写两遍）',
  )
  assert.deepEqual(requiredChannelsFor({ requiresChannels: ['feishu', 'feishu'], notify: { channel: 'feishu', require: true } }), ['feishu'])
})

test('门禁：没有渠道依赖 ⇒ 永远放行（不许给普通 job 增加新失败面）', () => {
  assert.deepEqual(evaluateChannelGate({ requires: [], reg: null }), { ok: true })
  assert.deepEqual(evaluateChannelGate({ requires: undefined, reg: { ok: false, error: 'x' } }), { ok: true })
})

test('门禁：loaded / healthy 都算可用（配置面已挂载 与 运行面探过）', () => {
  assert.deepEqual(evaluateChannelGate({ requires: ['feishu'], reg: reg([entry('feishu', 'dsh', 'loaded')]) }), { ok: true })
  assert.deepEqual(evaluateChannelGate({ requires: ['feishu'], reg: reg([entry('feishu', 'dsh', 'healthy')]) }), { ok: true })
  assert.ok(CHANNEL_OK_STATES.has('loaded') && CHANNEL_OK_STATES.has('healthy'))
})

test('门禁：不可用状态一律拦下，并点名渠道 + 带上证据（负向控制）', () => {
  for (const state of ['disabled', 'uninstalled', 'declared-disabled', 'dead-endpoint', 'unknown', 'failed']) {
    const gate = evaluateChannelGate({ requires: ['feishu'], reg: reg([entry('feishu', 'dsh', state, 'evidence-x')]) })
    assert.equal(gate.ok, false, `${state} 不应放行`)
    assert.equal(gate.reason, 'channel_unavailable')
    assert.match(gate.detail, new RegExp(`feishu=${state}`))
    assert.match(gate.detail, /evidence-x/)
  }
})

test('门禁：健康面里没有该条目 ⇒ channel_unavailable（missing 是配置缺失，不是"可用"）', () => {
  const gate = evaluateChannelGate({ requires: ['telegram'], reg: reg([entry('feishu', 'dsh', 'loaded')]) })
  assert.equal(gate.ok, false)
  assert.match(gate.detail, /telegram=missing/)
})

test('门禁：同一渠道两侧各一条 ⇒ **任一**可用即放行（能力不是位置）', () => {
  const gate = evaluateChannelGate({
    requires: ['wechat'],
    reg: reg([entry('wechat', 'dsh', 'uninstalled'), entry('wechat', 'los', 'healthy')]),
  })
  assert.deepEqual(gate, { ok: true })
})

test('门禁：健康面读不到 ⇒ 单独一个 reason（判不了 ≠ 不可用）', () => {
  const gate = evaluateChannelGate({ requires: ['feishu'], reg: { ok: false, error: '读不到健康面：ENOENT' } })
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'channel_registry_unreadable')
  assert.match(gate.detail, /ENOENT/)
  assert.ok(CHANNEL_GATE_REASONS.includes(gate.reason))
})

test('readChannelRegistry：坏 JSON / 缺 channels → ok:false，不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chan-gate-'))
  try {
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{not json')
    assert.equal(readChannelRegistry(bad).ok, false)
    const noChannels = join(dir, 'nochannels.json')
    writeFileSync(noChannels, JSON.stringify({ version: 1, asOf: 'x' }))
    assert.match(readChannelRegistry(noChannels).error, /channels/)
    assert.equal(readChannelRegistry(join(dir, 'missing.json')).ok, false)

    const good = join(dir, 'good.json')
    writeFileSync(good, JSON.stringify({ version: 1, asOf: new Date().toISOString(), channels: [entry('feishu', 'dsh', 'loaded')] }))
    const read = readChannelRegistry(good)
    assert.equal(read.ok, true)
    assert.equal(read.registry.channels.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('channelRegistryPath：DSH_CHANNEL_REGISTRY 优先，其次 $DSH_HOME/storages', () => {
  assert.equal(channelRegistryPath({ DSH_CHANNEL_REGISTRY: '/x/y.json', DSH_HOME: '/h' }), '/x/y.json')
  assert.equal(channelRegistryPath({ DSH_HOME: '/h' }), join('/h', 'storages', 'channel-registry.json'))
})

test('两个新归因都登记进 FAILURE_KINDS，且算"环境类"（不重试、但不许静默）', () => {
  for (const kind of CHANNEL_GATE_REASONS) {
    assert.ok(FAILURE_KINDS.includes(kind), `${kind} 未登记`)
    assert.ok(ENVIRONMENT_KINDS.has(kind), `${kind} 应为环境类（重试无意义）`)
    assert.equal(isEnvironmentFailure(kind), true)
    assert.match(describeFailureKind(kind), /渠道/)
  }
})
