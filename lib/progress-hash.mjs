/**
 * progress-hash.mjs — 给 finish 事件算「产物哈希 / 动作哈希」的零依赖纯函数。
 *
 * 为什么需要（2026-10-31 Super-agent 卡 T3）：
 *   契约方是 `dsfolder/scripts/agent-progress-watchdog.mjs`。它只回答一件事：
 *   **同样的动作反复跑，受检产物到底变没变**。为此它要求 runs.jsonl 的
 *   `evt:"finish"` 行带 `progress.artifactHash` 与 `progress.actionHash`；
 *   字段缺失时它必须判 unknown（exit 2），禁止拿 exitCode / 耗时 / outputHead 代替。
 *   生产端（本插件）因此要做的只有两件：按 job 声明的路径算产物哈希、按 job 的
 *   原始动作参数算动作哈希。**判词仍在 watchdog，本模块不做任何判定**。
 *
 * 三条口径（缺一条就会造出假绿）：
 *   1. **没有声明就没有哈希**。`job.artifactPaths` 未声明/为空 ⇒ 不产出 progress，
 *      让 watchdog 落回 unknown。绝不拿「整个 workspace 的 mtime」「outputHead」凑数。
 *   2. **读不到就没有哈希**。声明了但文件缺失/不可读/超过体积上限 ⇒ 只写
 *      `artifactProblems`，**不写** artifactHash ⇒ watchdog 判 missing-progress.artifactHash。
 *      用「空集哈希」冒充会得到一个永远不变的 artifactHash，那是把 unknown 伪装成 stalled。
 *   3. **动作哈希取原始声明，不取投影**。prompt 里的 runKey/预算占位符按原文参与哈希
 *      （渲染后每次触发都不同，那样的 actionHash 永远在变，会把 drifting 洗成 stalled）。
 *      台账里的 status/耗时/交付字段都是投影，不参与。
 *
 * 关于开销：哈希在 finish() 里同步做，因此单文件上限 32 MiB、单作业最多 20 条
 * （上限在 normalizeJob 里钉住）。声明的是「报告/台账」这类小产物，不是模型权重。
 */

import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** 单个受检文件的内容上限；超过则拒绝哈希（宁 unknown 不造假哈希）。 */
export const ARTIFACT_MAX_BYTES = 32 * 1024 * 1024

/** 单个作业可声明的受检路径条数上限（与 normalizeJob 的截断保持一致）。 */
export const ARTIFACT_MAX_PATHS = 20

/**
 * 参与动作哈希的字段 —— **job 的原始声明**，不是运行投影。
 * 判据：换掉这些字段中的任何一个，agent 该做的事就变了。
 *   - prompt/workspace：做什么、在哪做
 *   - model：谁来做（换模型=换做法）
 *   - assertCmd：验收方式变了，动作的可判形态也变了
 *   - deliverTo/deliveryKey：交付目标与幂等键模板（模板未渲染）
 *   - maxRunsPerDay：动作预算
 * 明确**不**参与：name（只是标签）、trigger（调度不是动作）、enabled、
 * notify、maxAttempts/retryDelayMs/timeoutMs（策略而非动作）、artifactPaths
 * （受检面变了不代表动作变了 —— 让它参与会把「换了检查项」误判成「换了做法」）。
 */
export const ACTION_FIELDS = [
  'workspace', 'prompt', 'model', 'assertCmd', 'deliverTo', 'deliveryKey', 'maxRunsPerDay',
]

/** 递归稳定序列化（键排序），保证同一份声明永远得到同一串字节。 */
export function stableStringify(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** 取 job 的动作参数原样（只挑 ACTION_FIELDS；缺的字段不补默认值）。 */
export function actionPayload(job) {
  const out = {}
  for (const field of ACTION_FIELDS) {
    if (job?.[field] !== undefined) out[field] = job[field]
  }
  return out
}

/** sha256(actionPayload) —— 同一份动作声明永远同一个值。 */
export function computeActionHash(job) {
  return createHash('sha256').update(stableStringify(actionPayload(job)), 'utf8').digest('hex')
}

/**
 * 受检路径里的日期占位符：日报/周报的产物名带日期（`report-20261101.md`），
 * 没有占位符时声明只能写死某一天，第二天就变成"读不到"⇒ 永远 unknown。
 * 判据边界：占位符在**解析路径前**展开，但 artifactHash 里进的是**未展开的声明模板**
 * （见 computeProgress）—— 同内容 + 同模板 ⇒ 同哈希，日期变化不会被误判成"产物在变"。
 */
export const DATE_PLACEHOLDER = '{{DSH_SCHED_DATE}}'
export const DATE_COMPACT_PLACEHOLDER = '{{DSH_SCHED_DATE_COMPACT}}'

/** 把一次触发时刻折算成该作业时区里的日期（用于展开路径占位符）。 */
export function dateVars(iso, timeZone) {
  const at = new Date(iso ?? Date.now())
  const when = Number.isNaN(at.getTime()) ? new Date() : at
  let date
  try {
    date = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(when)
  } catch {
    // 非法时区（job.trigger.timezone 是自由文本）⇒ 退回宿主本地，不抛。
    date = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(when)
  }
  return { date, dateCompact: date.replace(/-/g, '') }
}

/** `~` 展开 + 日期占位符 + 绝对/相对（相对基准 = job workspace）解析；空路径返回 null。 */
export function resolveArtifactPath(declared, cwd, vars) {
  const raw = String(declared ?? '').trim()
  if (raw === '') return null
  return resolveArtifactPathRaw(expandArtifactPath(raw, vars), cwd)
}

/** 只做占位符替换（导出以便测试与复用）。 */
export function expandArtifactPath(declared, vars) {
  const raw = String(declared ?? '')
  if (!vars) return raw
  return raw
    .split(DATE_PLACEHOLDER).join(vars.date ?? '')
    .split(DATE_COMPACT_PLACEHOLDER).join(vars.dateCompact ?? '')
}

function resolveArtifactPathRaw(rawPath, cwd) {
  const raw = String(rawPath ?? '').trim()
  if (raw === '') return null
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  if (isAbsolute(raw)) return raw
  return resolve(cwd ?? process.cwd(), raw)
}

/**
 * 流式 synchronous sha256（分 1 MiB 读，不把整个文件读进内存）。
 * @returns {{ok:true, sha256:string, bytes:number} | {ok:false, reason:string}}
 */
export function hashFileSync(file) {
  let stat
  try {
    stat = statSync(file)
  } catch (error) {
    return { ok: false, reason: `unreadable(${error?.code ?? 'error'})` }
  }
  if (!stat.isFile()) return { ok: false, reason: 'not-a-file' }
  if (stat.size > ARTIFACT_MAX_BYTES) {
    return { ok: false, reason: `too-large(${stat.size}B>${ARTIFACT_MAX_BYTES}B)` }
  }
  let fd
  try {
    fd = openSync(file, 'r')
    const hash = createHash('sha256')
    const buf = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const read = readSync(fd, buf, 0, buf.length, null)
      if (read <= 0) break
      hash.update(buf.subarray(0, read))
    }
    return { ok: true, sha256: hash.digest('hex'), bytes: stat.size }
  } catch (error) {
    return { ok: false, reason: `unreadable(${error?.code ?? 'error'})` }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* nothing to recover: hash already decided */ }
    }
  }
}

/**
 * 算一条 finish 行的 `progress` 载荷。
 *
 * @param {object} job 作业定义（原样，不要传投影）
 * @param {{cwd?: string, vars?: {date:string,dateCompact:string}}} [options]
 *   cwd = 相对路径的基准（通常是 job workspace）；vars = 日期占位符的取值
 * @returns {{declared:boolean, progress:object|null, reason?:string}}
 *   declared=false ⇒ 调用方**必须**不写 progress（watchdog 落 unknown）
 *   declared=true 且 progress.artifactHash 缺失 ⇒ 产物读不到，同样只能 unknown
 */
export function computeProgress(job, { cwd, vars } = {}) {
  const declared = Array.isArray(job?.artifactPaths)
    ? job.artifactPaths.map((p) => String(p ?? '').trim()).filter(Boolean)
    : []
  if (declared.length === 0) {
    return { declared: false, progress: null, reason: 'no-artifactPaths-declared' }
  }
  const base = cwd ?? job?.workspace
  const actionHash = computeActionHash(job)
  const entries = []
  const problems = []
  let bytes = 0
  for (const item of declared) {
    const resolved = resolveArtifactPath(item, base, vars)
    if (!resolved) {
      problems.push(`${item}: empty-path`)
      continue
    }
    const hashed = hashFileSync(resolved)
    if (!hashed.ok) {
      problems.push(`${item}: ${hashed.reason}`)
      continue
    }
    bytes += hashed.bytes
    // 声明模板（未展开）+ 内容摘要 + 字节数一起进聚合串：改声明（换检查项）与改内容都可区分，
    // 而日期占位符的展开结果不参与 —— 否则"每天一个新文件名"会被误读成"产物在变"。
    entries.push(`${item}\t${hashed.sha256}\t${hashed.bytes}`)
  }
  if (problems.length > 0) {
    // 读不到就不给 artifactHash —— 否则空集哈希会变成一个永远不变的"产物"。
    return {
      declared: true,
      progress: { actionHash, artifactPaths: declared, artifactProblems: problems },
      reason: 'artifact-unreadable',
    }
  }
  const artifactHash = createHash('sha256').update(entries.join('\n'), 'utf8').digest('hex')
  return {
    declared: true,
    progress: { artifactHash, actionHash, artifactPaths: declared, artifactBytes: bytes },
    reason: 'ok',
  }
}
