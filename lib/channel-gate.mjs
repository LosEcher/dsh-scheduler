// 渠道依赖门禁（L2-4）：**渠道不熟时不要"跑一遍再失败"**。
//
// 事故形状（2026-10-07/08 复盘）：`daily execution digest (feishu)` 这类任务 enabled，
// 但渠道可用性没有前置检查 ⇒ 渠道关了/插件没装时，run 照跑一遍、prompt 里的 push 发不出去，
// 台账只留下 delivery_missing（该发而没发）或 exit=0（脚本层"没发也算成功"）。
// 更糟的是它消耗了 run 预算与失败链，把"渠道不可用"说成"任务写坏了"。
//
// 判据：job 声明 `requiresChannels: ["feishu"]`（或隐含：`notify.require === true` ⇒ 要求
// `notify.channel`），执行前读**唯一健康面** `~/.dsh/storages/channel-registry.json`
// （由 `dsfolder/scripts/channel-registry.mjs probe --apply` 每日刷新）。
// 任一渠道 `state ∉ {loaded, healthy}` ⇒ 本次 run 记 `skipped: channel_unavailable`。
//
// 三态纪律（与本仓其它判据一致）：
//   · **健康面读不到 ≠ 渠道不可用**：前者报 `channel_registry_unreadable`（判不了，需人去修探针），
//     后者报 `channel_unavailable`（配置面的事实）。两者都不许折成"跑了但没发"。
//   · `unknown` 状态 = 探针读不到权威输入 ⇒ 按"不可用"处理（fail-loud），但 detail 里写清是 unknown。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 允许开跑的状态：`loaded`=配置面已挂载；`healthy`=运行面探过且在。 */
export const CHANNEL_OK_STATES = new Set(['loaded', 'healthy'])

/** 门禁会返回的两个 skip 原因（都登记进 failure-class 的 FAILURE_KINDS）。 */
export const CHANNEL_GATE_REASONS = ['channel_unavailable', 'channel_registry_unreadable']

/** 健康面路径：`DSH_CHANNEL_REGISTRY` 优先，否则 `$DSH_HOME/storages/channel-registry.json`。 */
export function channelRegistryPath(env = process.env) {
  const override = env.DSH_CHANNEL_REGISTRY
  if (typeof override === 'string' && override.length > 0) return override
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'storages', 'channel-registry.json')
}

/** @returns {{ok:true, registry:object} | {ok:false, error:string}} */
export function readChannelRegistry(path) {
  try {
    const registry = JSON.parse(readFileSync(path, 'utf8'))
    if (!registry || typeof registry !== 'object' || !Array.isArray(registry.channels)) {
      return { ok: false, error: '健康面结构不合法（缺 channels 数组）' }
    }
    return { ok: true, registry }
  } catch (error) {
    return { ok: false, error: `读不到健康面：${error?.code ?? error?.message ?? String(error)}` }
  }
}

/**
 * 这个 job 到底依赖哪些渠道（显式声明 ∪ 从 notify 派生）。
 *
 * 派生理由：`notify.require === true` 的意思是"本次触发**必须**发出去" ⇒ 它**必然**依赖那个渠道；
 * 不派生就得在每个 job 上把同一件事写两遍（两份真源必漂）。`require === false` 只跟踪不强制，
 * 不构成依赖（渠道关了也允许跑完、只是没推送）。
 */
export function requiredChannelsFor(job) {
  const explicit = Array.isArray(job?.requiresChannels) ? job.requiresChannels : []
  const derived = job?.notify?.require === true ? [String(job.notify.channel ?? 'feishu')] : []
  return [...new Set([...explicit, ...derived].map(c => String(c).trim()).filter(Boolean))].sort()
}

/**
 * 门禁判定（纯函数）。
 *
 * @param {object} input
 * @param {string[]} input.requires   需要的渠道 id
 * @param {{ok:boolean, registry?:object, error?:string}} input.reg  readChannelRegistry 的结果
 * @returns {{ok:true} | {ok:false, reason:string, detail:string}}
 */
export function evaluateChannelGate({ requires, reg } = {}) {
  const wanted = Array.isArray(requires) ? requires.filter(Boolean) : []
  if (wanted.length === 0) return { ok: true }
  if (!reg || reg.ok !== true) {
    return {
      ok: false,
      reason: 'channel_registry_unreadable',
      detail: `需要渠道 ${wanted.join(',')}，但${reg?.error ?? '健康面不可读'} —— 先跑 dsfolder/scripts/channel-registry.mjs probe --apply`,
    }
  }
  const channels = Array.isArray(reg.registry?.channels) ? reg.registry.channels : []
  const unavailable = []
  for (const id of wanted) {
    const entries = channels.filter(c => c && c.id === id)
    if (entries.length === 0) {
      unavailable.push(`${id}=missing（健康面里没有该条目）`)
      continue
    }
    // 同一 id 可能在两侧（dsh/los）各有一条：**任一**满足即可（渠道是能力，不是位置）
    if (entries.some(e => CHANNEL_OK_STATES.has(e.state))) continue
    const e = entries[0]
    unavailable.push(`${id}=${e.state}${e.evidence ? `（${String(e.evidence).slice(0, 120)}）` : ''}`)
  }
  if (unavailable.length === 0) return { ok: true }
  return {
    ok: false,
    reason: 'channel_unavailable',
    detail: unavailable.join('; '),
  }
}
