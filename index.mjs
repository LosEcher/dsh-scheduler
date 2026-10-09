/**
 * dsh-scheduler — host half.
 *
 * Durable scheduled tasks for DSH: cron / interval / once triggers persisted
 * under ~/.dsh/storages/dsh-scheduler, executed as one-shot headless agent
 * processes (`dsh --profile headless "<prompt>"`, cwd = job workspace), with
 * a run ledger and a same-origin REST API consumed by the client-half
 * management tab.
 *
 * Endpoints (prefix /scheduler):
 *   GET    /scheduler/status
 *   GET    /scheduler/jobs
 *   POST   /scheduler/jobs
 *   GET    /scheduler/jobs/:id
 *   PATCH  /scheduler/jobs/:id
 *   DELETE /scheduler/jobs/:id
 *   POST   /scheduler/jobs/:id/trigger
 *   POST   /scheduler/jobs/:id/pause | /resume
 *   GET    /scheduler/jobs/:id/runs?limit=50
 *   GET    /scheduler/preview?kind=cron&expression=...&timezone=...&n=5
 */

import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Store, newId, nowIso } from './lib/store.mjs'
import { parseCron, nextCronAfter, cronOccurrences, parseInterval, CronParseError } from './lib/cron-next.mjs'
import { renderModelOverridePatch } from './lib/model-override.mjs'

/** 插件版本（/plugins/<id>/status 约定用；读 package.json，失败返回 null）。 */
function pluginVersion() {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? null
  } catch {
    return null
  }
}

export const name = 'dsh-scheduler'
export const inject = ['webServer', 'agents']

// schemastery `.default()` stores the argument AS-IS (a literal): a factory
// function would fail Cordis string validation and take down the whole web
// plugin tree. Following the harness convention (settings-file: "defaulting
// happens here, never inline"): string fields stay default-less in the schema
// and env-derived values are resolved at runtime in resolveConfig(); number
// fields may carry literal defaults (retry-policy precedent).
export const Config = Schema.object({
  /** Storage root for jobs.json / runs.jsonl / lock (optional; resolved at runtime). */
  dataDir: Schema.string(),
  /** Harness root: dsh CLI entry lives here (optional; auto-discovered at runtime). */
  harnessDir: Schema.string(),
  /** Default workspace (cwd) for jobs that do not pin one (optional). */
  defaultWorkspace: Schema.string(),
  /** Per-run timeout before the headless process is killed (SIGTERM). */
  timeoutMs: Schema.number().min(10_000).default(30 * 60_000),
  /** Grace between SIGTERM and SIGKILL when a headless run does not exit. */
  killGraceMs: Schema.number().min(1_000).max(120_000).default(10_000),
  /** Max concurrent headless runs. */
  maxConcurrent: Schema.number().min(1).max(8).default(2),
  /** Periodic tick interval (drift/overdue catch-up). */
  tickMs: Schema.number().min(5_000).default(60_000),
  /** Auto-pause a job after this many consecutive failures (circuit breaker). */
  maxConsecutiveFailures: Schema.number().min(1).max(100).default(5),
  /**
   * Push a Feishu alert (via ~/.dsh/scripts/feishu-push.sh) once a job's
   * consecutive failures reach this threshold (0 disables). Fires once per
   * failure streak: the job's alertedFailures field records the level already
   * alerted, and a successful run resets it, so the next streak alerts again.
   */
  alertOnConsecutiveFailures: Schema.number().min(0).max(100).default(2),
  /** Total run attempts per logical trigger (1 = no retry). Jobs may override. */
  maxAttempts: Schema.number().min(1).max(10).default(3),
  /** Delay before a retry attempt after a transient failure (jobs may override). */
  retryDelayMs: Schema.number().min(5_000).max(30 * 60_000).default(60_000),
  /** Global catch-up policy ('run_once' fires a missed occurrence once; 'skip' drops it). */
  catchUpPolicy: Schema.string(),
  /**
   * Max ledger lines kept inline in runs.jsonl. Older lines are archived into
   * archive/runs-<YYYY-MM>.jsonl (never dropped). 2026-09-12 audit: the earlier
   * hard-coded 500 discarded ~90% of history whenever rotation ran.
   */
  maxRuns: Schema.number().min(100).default(5000),
  /** Per-run timeout for a job's assertCmd (its own mechanical acceptance test). */
  assertTimeoutMs: Schema.number().min(1_000).max(10 * 60_000).default(60_000),
  /**
   * 投递状态目录：与 ~/.dsh/scripts/feishu-push.sh 的 --key 状态目录同源
   * （脚本默认 $DSH_HOME/storages/feishu-push）。scheduler 从这里**派生**交付事实
   * （`<sha256(key) 前16位>.sent`），把「这次触发到底推了几条」变成台账里可查的
   * 事件，而不是只验「报告文件存在」（2026-10-03 重复推送复盘：7 起重复全在
   * assert 的盲区里）。
   */
  deliveryStateDir: Schema.string(),
  /** Max lateness for 'skip' catch-up; 0 = unlimited (never skip). */
  maxLatenessMs: Schema.number().min(0).default(15 * 60_000),
  /**
   * Global dispatch jitter: a scheduled job fires after a random delay in
   * [0, dispatchJitterMaxMs] past its cron instant. Spreads headless runs so
   * jobs do not all fire on the exact minute (and do not collide with
   * external :00/:30 schedulers). 0 disables; per-job override via
   * trigger.jitterMaxMs.
   */
  dispatchJitterMaxMs: Schema.number().min(0).max(30 * 60_000).default(3 * 60_000),
}).description('dsh-scheduler: DSH 定时任务（cron/interval/once + headless 执行 + 台账）')

/** Resolve runtime config: explicit values win, env falls back, then defaults. */
export function resolveConfig(config) {
  const dshHome = process.env.DSH_HOME ?? `${homedir()}/.dsh`
  return {
    dataDir: config.dataDir ?? `${dshHome}/storages/dsh-scheduler`,
    // harnessDir is optional: resolveCliEntry() auto-discovers the dsh CLI
    // (explicit config/env → ~/.dsh/source/current → profile install → error).
    harnessDir: config.harnessDir ?? process.env.DSH_HARNESS_DIR,
    defaultWorkspace: config.defaultWorkspace ?? process.env.DSH_SCHEDULER_WORKSPACE ?? homedir(),
    timeoutMs: config.timeoutMs ?? 30 * 60_000,
    killGraceMs: config.killGraceMs ?? 10_000,
    maxConcurrent: config.maxConcurrent ?? 2,
    tickMs: config.tickMs ?? 60_000,
    maxConsecutiveFailures: config.maxConsecutiveFailures ?? 5,
    alertOnConsecutiveFailures: config.alertOnConsecutiveFailures ?? 2,
    maxAttempts: config.maxAttempts ?? 3,
    retryDelayMs: config.retryDelayMs ?? 60_000,
    catchUpPolicy: config.catchUpPolicy === 'skip' ? 'skip' : 'run_once',
    maxLatenessMs: config.maxLatenessMs ?? 15 * 60_000,
    dispatchJitterMaxMs: config.dispatchJitterMaxMs ?? 3 * 60_000,
    maxRuns: config.maxRuns ?? 5000,
    assertTimeoutMs: config.assertTimeoutMs ?? 60_000,
    deliveryStateDir: config.deliveryStateDir ?? `${dshHome}/storages/feishu-push`,
  }
}

const MAX_TIMER_DELAY_MS = 2_147_483_647
const OUTPUT_TAIL_BYTES = 8192

const PREFLIGHT_ERROR_PATTERNS = [
  /ERR_MODULE_NOT_FOUND/i,
  /cannot find package/i,
  /cannot locate the dsh CLI/i,
]

/**
 * 解析不到 dsh CLI 时的补救指引。出现在三处，保证"红得可排障"：启动告警、
 * /plugins/dsh-scheduler/status 的 cliError、以及每次运行的 preflight 失败行。
 */
export const CLI_ENTRY_REMEDY =
  'dsh CLI 未找到：设置 DSH_HARNESS_DIR（或 harnessDir 配置）指向 harness 检出，'
  + '或安装 dsh 使 ~/.dsh/profiles/node_modules/@deepseek-ai/dsh 存在。'

/**
 * prompt 占位符：scheduler 在 spawn 前替换成本次触发的 runKey。
 *
 * 为什么不用环境变量（2026-10-03 端到端探针实测踩到）：DSH 的 bash 工具
 * **不继承 process.env** —— spawn 的 env 是 `ENV_OVERRIDES + spec.env + dshEnv`，
 * 而 dshEnv 来自 `ShellEnvRegistry.collect()`，其契约写明「每次模型 shell 调用都
 * 重建，ambient DSH_* 一律被 executor 丢弃」（packages/shell/shell-env/src/index.ts）。
 * 往子进程 env 塞 DSH_SCHED_RUN_KEY，agent 的 bash 里根本看不到。
 * prompt 替换不依赖任何 shell 环境，是让幂等键到达推送点的最短路径。
 */
export const RUN_KEY_PLACEHOLDER = '{{DSH_SCHED_RUN_KEY}}'

/**
 * 把 prompt 里的 runKey 占位符替换成本次触发的 runKey。
 * 无可替换内容时**原样返回**（旧 job 不受影响）；runKey 为空时也原样返回，
 * 绝不把占位符留成字面量——否则所有 job 会共用同一个假 key，互相 dedup 掉。
 */
export const DELIVERY_KEY_PLACEHOLDER = '{{DSH_SCHED_DELIVERY_KEY}}'

export function renderPrompt(prompt, runKey, deliveryKey) {
  let text = String(prompt ?? '')
  if (runKey && text.includes(RUN_KEY_PLACEHOLDER)) text = text.split(RUN_KEY_PLACEHOLDER).join(runKey)
  // 交付键占位符：job 配了 deliveryKey 模板时才有值；没配就**原样保留**
  // （与 runKey 同一条理由：绝不把占位符留成字面量，否则所有 job 共用一个假 key 互相 dedup）。
  if (deliveryKey && text.includes(DELIVERY_KEY_PLACEHOLDER)) {
    text = text.split(DELIVERY_KEY_PLACEHOLDER).join(deliveryKey)
  }
  return text
}

/**
 * 幂等键：一次 logical trigger 的**全部 attempt 共享**同一个 key。
 * attempt 有意不进 key —— 「重试不该重发」正是靠这一点成立的
 * （2026-10-03 事故：attempt2 推送成功后 4s 被杀，attempt3 换了报告文件名
 * 当 key，于是又推了一条）。
 */
export function computeRunKey(jobId, scheduledFor) {
  return `${jobId}|${scheduledFor}`
}

/**
 * 交付键（幂等键）——**事件域**，默认等于 runKey（槽位域）。
 *
 * 为什么需要它（2026-10-07 用 .sent 台账定位到根因）：runKey = `jobId|scheduledFor` 是
 * **槽位域**键。同一次真实事件被额外触发时 `scheduledFor` 会变（手动触发、补跑），键就变了，
 * 于是两条都推得出去；实测三起重复全是这个机制：
 *   - feed 作业 2026-10-06 同时出现 `…|05:35:00.000Z` 与 `…|05:37:00.000Z`（cron 槽 + 额外触发）；
 *   - 周更作业 2026-10-06 09:09–09:14 被触发 3 次 ⇒ 连推 3 条（三个 ad-hoc scheduledFor）。
 * 结论：**「每键一次」≠「每事件一次」**。给 job 配一个事件域模板即可对齐：
 *   `deliveryKey: 'feed-digest-{{jobId}}-{{date}}-{{hour}}'`
 * 占位符：{{jobId}} {{runKey}} {{scheduledFor}} {{date}}(本地 YYYYMMDD) {{hour}}(本地 HH) {{slot}}(本地 HHMM)。
 * 未配 deliveryKey ⇒ 返回 runKey，**行为与改动前逐位一致**（旧 job 零影响）。
 */
export function computeDeliveryKey(job, runKey, scheduledFor, now = new Date()) {
  const template = job && typeof job.deliveryKey === 'string' ? job.deliveryKey.trim() : ''
  if (!template) return runKey
  const pad = (n) => String(n).padStart(2, '0')
  const d = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date()
  const local = {
    date: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`,
    hour: pad(d.getHours()),
    slot: `${pad(d.getHours())}${pad(d.getMinutes())}`,
  }
  return template
    .split('{{jobId}}').join(String(job?.id ?? ''))
    .split('{{runKey}}').join(String(runKey ?? ''))
    .split('{{scheduledFor}}').join(String(scheduledFor ?? ''))
    .split('{{date}}').join(local.date)
    .split('{{hour}}').join(local.hour)
    .split('{{slot}}').join(local.slot)
}

/**
 * 交付越界检测（2026-10-07）：本次 run 期间，交付目录里出现了**不是交付键**的 .sent/.skipped。
 *
 * 为什么需要（实测踩到）：feed 作业 2026-10-07 21:35 槽的 attempt 1，agent **自造了 key**
 * （`feed-<日期>-<HHMM>`）而不是用注入的键 —— 于是同一次触发真的推了两条；而按 run key 的交付检查
 * 只看到 `missing`（它照实报了"该发而没发"），系统无法察觉**另一条已经用别的键发出去了**。
 * 投递审计的"飞书侧聚类"能事后发现，但那要等一周；这一条把它变成**当次即红**。
 *
 * 判据：文件 mtime ≥ run 开始时间（留 2s 余量）且文件里的 key ≠ 交付键 ⇒ 越界。
 * 记账内容自带 `key` 字段（.sent/.skipped 都是 JSON），所以不必反解 hash。
 */
export function findStrayDeliveries(stateDir, deliveryKey, sinceMs) {
  if (!stateDir || !deliveryKey || !Number.isFinite(sinceMs)) return []
  const strays = []
  let names = []
  try { names = readdirSync(stateDir) } catch { return [] }
  for (const name of names) {
    if (!name.endsWith('.sent') && !name.endsWith('.skipped')) continue
    const full = join(stateDir, name)
    try {
      const st = statSync(full)
      if (st.mtimeMs < sinceMs - 2000) continue          // 本次 run 之前写的，不算
      const rec = JSON.parse(readFileSync(full, 'utf8'))
      const key = typeof rec?.key === 'string' ? rec.key : null
      if (key && key !== deliveryKey) strays.push(key)
    } catch { /* 半写/损坏：跳过 */ }
  }
  return strays
}

/** 与 feishu-push.sh 的 key_hash 逐位对齐：sha256(key) 的 hex 前 16 位。 */
export function deliveryKeyHash(key) {
  return createHash('sha256').update(String(key), 'utf8').digest('hex').slice(0, 16)
}

/**
 * 从 push 脚本的 .sent 记录**派生**交付事实（读不到 = 未投递）。
 * 纯读 + 容错：目录/文件缺失、写到一半、JSON 损坏一律返回 null，绝不抛
 * （调用点在 finish 里，任何异常都会打断台账写入）。
 */
export function readDeliveryRecord(stateDir, key) {
  if (!stateDir || !key) return null
  try {
    const raw = readFileSync(join(stateDir, `${deliveryKeyHash(key)}.sent`), 'utf8')
    const rec = JSON.parse(raw)
    return {
      channel: typeof rec.channel === 'string' ? rec.channel : 'feishu',
      key,
      messageId: typeof rec.messageId === 'string' ? rec.messageId : null,
      sentAt: typeof rec.sentAt === 'string' ? rec.sentAt : null,
    }
  } catch {
    return null
  }
}

/**
 * 读「合法静默」标记（`feishu-push.sh --skip` 写的 `<hash>.skipped`）。
 *
 * 为什么需要第三态：prompt 里有**合法的"本次不推送"分支**——例如 feed job 当日
 * 故障已通知过就静默（避免同日重复打扰）。若只认 `.sent`，那种情况会被记成
 * missing（漏发），`notify.require` 便永远无法开启（2026-10-03 实测：21:35 那次
 * run 正确静默，却被记成 delivered=missing）。三态后：delivered=发了；
 * skipped=有意没发；missing=该发而没发（唯一该判失败的那种）。
 */
export function readSkipRecord(stateDir, key) {
  if (!stateDir || !key) return null
  try {
    const raw = readFileSync(join(stateDir, `${deliveryKeyHash(key)}.skipped`), 'utf8')
    const rec = JSON.parse(raw)
    return {
      channel: 'feishu',
      key,
      reason: typeof rec.reason === 'string' && rec.reason !== '' ? rec.reason : 'skipped',
      at: typeof rec.at === 'string' ? rec.at : null,
    }
  } catch {
    return null
  }
}

/** Validate local execution prerequisites before spending an attempt. */
export function preflightExecution(entry, workspace) {
  if (!entry || !Array.isArray(entry.args) || entry.args.length === 0) {
    return `preflight: dsh CLI entry is missing — ${CLI_ENTRY_REMEDY}`
  }
  if (!workspace || !String(workspace).trim()) return 'preflight: workspace is empty'
  const source = String(entry.source ?? '')
  if (PREFLIGHT_ERROR_PATTERNS.some((pattern) => pattern.test(source))) {
    return `preflight: invalid CLI entry (${source})`
  }
  return null
}

function tail(text, max = OUTPUT_TAIL_BYTES) {
  const buf = Buffer.from(text)
  return buf.length <= max ? text : buf.subarray(buf.length - max).toString('utf8')
}

function renderThrown(value) {
  return value instanceof Error ? value.message : String(value)
}

// ---- trigger helpers --------------------------------------------------------

function normalizeTimezone(timezone) {
  const tz = (timezone ?? '').trim() || 'local'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz === 'local' ? undefined : tz })
    return tz
  } catch {
    throw new CronParseError(`invalid timezone "${tz}"`)
  }
}

/** Validate + normalize a trigger object; returns the stored form. */
export function normalizeTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object') throw new CronParseError('trigger is required')
  const kind = String(trigger.kind ?? '')
  const expression = String(trigger.expression ?? '').trim()
  const timezone = normalizeTimezone(trigger.timezone)
  if (expression === '') throw new CronParseError('trigger.expression is required')
  let everySeconds
  switch (kind) {
    case 'cron':
      parseCron(expression) // throws on invalid
      break
    case 'interval':
      everySeconds = parseInterval(expression)
      break
    case 'once': {
      const t = Date.parse(expression)
      if (Number.isNaN(t)) throw new CronParseError(`once: invalid ISO timestamp "${expression}"`)
      break
    }
    default:
      throw new CronParseError(`trigger.kind must be cron | interval | once, got "${kind}"`)
  }
  // Dispatch jitter (optional): max random delay before firing this job's
  // scheduled occurrence. 0 disables. Absent → falls back to the global
  // dispatchJitterMaxMs at dispatch time.
  let jitterMaxMs
  if (trigger.jitterMaxMs !== undefined && trigger.jitterMaxMs !== null) {
    jitterMaxMs = Number(trigger.jitterMaxMs)
    if (!Number.isFinite(jitterMaxMs) || jitterMaxMs < 0) {
      throw new CronParseError(`trigger.jitterMaxMs must be a non-negative number, got "${trigger.jitterMaxMs}"`)
    }
  }
  return {
    kind,
    expression,
    timezone,
    ...(everySeconds !== undefined ? { everySeconds } : {}),
    ...(jitterMaxMs !== undefined ? { jitterMaxMs } : {}),
  }
}

/** Next fire instant (epoch ms) for a normalized job after `now`, or null. */
export function computeNextRun(job, now) {
  const { kind, expression, timezone } = job.trigger
  if (kind === 'cron') {
    return nextCronAfter(parseCron(expression), now, timezone)
  }
  if (kind === 'interval') {
    const every = job.trigger.everySeconds ?? parseInterval(expression)
    return now + every * 1000
  }
  const t = Date.parse(expression)
  return t > now ? t : null // once: fired (or missed) → done
}

/** Preview the next `count` fire instants. */
export function previewTrigger(kind, expression, timezone, count = 5) {
  const tz = normalizeTimezone(timezone)
  const now = Date.now()
  if (kind === 'cron') return cronOccurrences(expression, tz, now, count)
  if (kind === 'interval') {
    const every = parseInterval(expression) * 1000
    const out = []
    for (let i = 1; i <= count; i++) out.push(new Date(now + every * i).toISOString())
    return out
  }
  const t = Date.parse(expression)
  if (Number.isNaN(t)) throw new CronParseError(`once: invalid ISO timestamp "${expression}"`)
  return [new Date(t).toISOString()]
}

// ---- pure decision functions (unit-testable) ---------------------------------

/**
 * Failure output patterns that indicate a *persistent* condition — retrying
 * cannot help and would just burn quota/attempts (billing/quota/credentials).
 * Transient failures (network TRANSPORT errors, 5xx, timeouts, arbitrary
 * non-zero exits) are retryable. `rate limit` (429) is intentionally NOT
 * listed: it usually clears within the retry delay.
 */
const NON_RETRYABLE_PATTERNS = [
  /\b402\b/i,
  /\bpayment\s+required\b/i,
  /\binsufficient\b/i,
  // quota/credit in a failure output is almost always a billing/quota context
  // ("quota has been exhausted", "insufficient credits", "credits depleted").
  /\b(quota|credits?)\b/i,
  /\bbalance\s+(low|not\s+enough|insufficient|exhausted|zero)\b/i,
  /\b401\b/i,
  /\bunauthorized\b/i,
  /\binvalid\s+(api\s*)?key\b/i,
  /\bauthentication\s+(failed|error)\b/i,
  /\b403\b/i,
  /\bforbidden\b/i,
  /\bbilling\s+(error|issue|problem)\b/i,
  /\baccount\s+(disabled|suspended|banned)\b/i,
]

/**
 * Model-availability failures: upstreams (e.g. opencode-zen) often frame
 * "model not supported / unavailable" as 401/400, which NON_RETRYABLE_PATTERNS
 * would otherwise swallow. These are transient in practice — the model may come
 * back, and the run's fallback chain exists precisely to absorb them — so they
 * must stay retryable for the fallback model to ever run (2026-08-31 hermes
 * job: `AUTH: 401 ... "Model hy3-free is not supported"` never reached the
 * deepseek fallback).
 */
const MODEL_UNAVAILABLE_PATTERNS = [
  /\bmodel\b[^\n]*(?:not\s+supported|unavailable|not\s+found|not\s+available)/i,
  /\bmodel\s+is\s+unavailable\b/i,
]

/** Transient failures are retryable; persistent ones (quota/auth/billing) are not. */
export function isRetryableFailure(output) {
  if (!output) return true
  if (MODEL_UNAVAILABLE_PATTERNS.some((re) => re.test(output))) return true
  return !NON_RETRYABLE_PATTERNS.some((re) => re.test(output))
}

/**
 * Decide whether a failed run should be retried. Success never retries;
 * attempts are capped at maxAttempts (job-level override wins); persistent
 * failures (quota/auth/billing) are never retried.
 */
export function shouldRetry(job, cfg, status, output, attempt) {
  if (status === 'succeeded') return false
  const max = job.maxAttempts ?? cfg.maxAttempts
  if (attempt >= max) return false
  return isRetryableFailure(output)
}

/**
 * Decide whether a due job should fire or be skipped by the catch-up policy.
 * `run_once` (default) fires a missed occurrence once, however late; `skip`
 * drops it when lateness exceeds `maxLatenessMs` (0 = unlimited).
 */
export function decideCatchUp(job, cfg, now) {
  const scheduledAt = Date.parse(job.nextRunAt)
  const latenessMs = now - scheduledAt
  const policy = job.catchUpPolicy ?? cfg.catchUpPolicy
  if (policy === 'skip' && cfg.maxLatenessMs > 0 && latenessMs > cfg.maxLatenessMs) {
    return { action: 'skip', latenessMs }
  }
  return { action: 'fire', latenessMs }
}

/**
 * Fold one run result into a job (pure): updates last-run fields, failure
 * counter, next occurrence, and auto-pauses (circuit breaker) once
 * consecutive failures reach `maxConsecutiveFailures`.
 */
export function applyRunResult(job, result, cfg, completedAt) {
  const succeeded = result.status === 'succeeded'
  const consecutiveFailures = succeeded ? 0 : (job.consecutiveFailures ?? 0) + 1
  const tripped = !succeeded && consecutiveFailures >= cfg.maxConsecutiveFailures
  const paused = job.state === 'paused' || job.enabled === false
  // Failure-alert watermark: success resets it so the next failure streak can
  // alert again; a failed run keeps the previous watermark (the caller bumps
  // it to the current level after pushing, via upsert, so one streak = one alert).
  const alertedFailures = succeeded ? 0 : (job.alertedFailures ?? 0)
  // Dispatch-time accounting already advanced nextRunAt when the scheduled
  // run was fired; keep that value so interval jobs measure their period from
  // dispatch, not completion (and so a crash between dispatch and finish can
  // never be re-fired by catch-up). Manual/retry paths recompute as before.
  const advanced = job.nextRunAt && Date.parse(job.nextRunAt) > Date.now()
  const next = paused
    ? (job.nextRunAt ? Date.parse(job.nextRunAt) : null)
    : (advanced ? Date.parse(job.nextRunAt) : computeNextRun(job, Date.now()))
  let state = job.state
  if (tripped) state = 'paused'
  else if (next === null && job.trigger.kind === 'once') state = 'completed'
  return {
    ...job,
    lastRunAt: completedAt,
    lastStatus: result.status,
    runCount: (job.runCount ?? 0) + 1,
    consecutiveFailures,
    alertedFailures,
    // Surfaced by /scheduler/status: how late the last dispatch actually was
    // (host asleep/blocked makes a cron job fire tens of minutes late).
    lastDispatchLatencyMs: result.dispatchLatencyMs ?? job.lastDispatchLatencyMs ?? null,
    nextRunAt: next ? new Date(next).toISOString() : null,
    state,
    enabled: tripped ? false : job.enabled,
    pausedReason: tripped ? 'max_consecutive_failures' : (job.pausedReason ?? undefined),
    updatedAt: completedAt,
  }
}

/** Render the followup text delivered into a target session. */
export function renderDelivery(job, run) {
  const lines = [
    `【dsh-scheduler】定时任务「${job.name}」执行${run.status === 'succeeded' ? '完成' : '失败'}（${run.status}）`,
    `- 触发: ${run.scheduledFor}（${run.triggerKind === 'manual' ? '手动' : '定时'}）`,
  ]
  if (run.durationMs !== undefined) lines.push(`- 耗时: ${(run.durationMs / 1000).toFixed(1)}s`)
  if (run.exitCode !== undefined) lines.push(`- exit: ${run.exitCode}`)
  if (run.error) lines.push(`- 错误: ${run.error}`)
  if (run.outputHead) lines.push('', '```', String(run.outputHead).slice(0, 2000), '```')
  return lines.join('\n')
}

/** Validate a job payload (create/update), returns normalized job fields. */
export function normalizeJob(input, existing) {
  if (!input || typeof input !== 'object') throw new Error('invalid job payload')
  const name = String(input.name ?? existing?.name ?? '').trim()
  const prompt = String(input.prompt ?? existing?.prompt ?? '').trim()
  if (name === '') throw new Error('name is required')
  if (prompt === '') throw new Error('prompt is required')
  const trigger = normalizeTrigger(input.trigger ?? existing?.trigger)
  const workspace = String(input.workspace ?? existing?.workspace ?? '').trim()
  const enabled = input.enabled !== undefined ? Boolean(input.enabled) : (existing?.enabled ?? true)
  // deliverTo: { sessionId } or null to clear; undefined keeps the existing value.
  let deliverTo = existing?.deliverTo
  if (input.deliverTo !== undefined) {
    const raw = input.deliverTo
    deliverTo = raw && typeof raw === 'object' && typeof raw.sessionId === 'string' && raw.sessionId.trim() !== ''
      ? { sessionId: raw.sessionId.trim() }
      : null
  }
  // catchUpPolicy: per-job override of the global policy; undefined keeps existing.
  let catchUpPolicy = existing?.catchUpPolicy
  if (input.catchUpPolicy !== undefined) {
    catchUpPolicy = input.catchUpPolicy === 'skip' || input.catchUpPolicy === 'run_once' ? input.catchUpPolicy : undefined
  }
  // maxAttempts / retryDelayMs: per-job overrides of the global retry policy.
  // null clears the override (back to global), undefined keeps existing.
  let maxAttempts = existing?.maxAttempts
  if (input.maxAttempts !== undefined && input.maxAttempts !== null) {
    const v = Number(input.maxAttempts)
    maxAttempts = Number.isInteger(v) ? Math.min(Math.max(v, 1), 10) : undefined
  } else if (input.maxAttempts === null) {
    maxAttempts = undefined
  }
  let retryDelayMs = existing?.retryDelayMs
  if (input.retryDelayMs !== undefined && input.retryDelayMs !== null) {
    const v = Number(input.retryDelayMs)
    retryDelayMs = Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 5_000), 30 * 60_000) : undefined
  } else if (input.retryDelayMs === null) {
    retryDelayMs = undefined
  }
  // model: per-job model override {provider, model, reasoningEffort?, fallback?}
  // run through the headless profile's default model settings. fallback is an
  // ordered list of models tried on later attempts (attempt 1 uses the primary
  // model; attempts ≥2 use the last fallback entry, or the primary when none
  // is declared). null clears, undefined keeps.
  let model = existing?.model
  if (input.model !== undefined) {
    if (input.model === null) {
      model = undefined
    } else if (typeof input.model === 'object') {
      const provider = String(input.model.provider ?? '').trim()
      const mdl = String(input.model.model ?? '').trim()
      if (provider === '' || mdl === '') throw new Error('model.provider and model.model are required')
      const reasoningEffort = input.model.reasoningEffort !== undefined
        ? String(input.model.reasoningEffort).trim()
        : undefined
      const fallback = normalizeModelChain(input.model.fallback)
      model = { provider, model: mdl, ...(reasoningEffort ? { reasoningEffort } : {}), ...(fallback.length ? { fallback } : {}) }
    } else {
      throw new Error('model must be an object {provider, model, reasoningEffort?, fallback?}')
    }
  }
  // assertCmd: optional mechanical acceptance test. Runs via /bin/bash -lc in
  // the job workspace after a clean exit; non-zero marks the run failed
  // ("green but empty" guard). Null clears, undefined keeps.
  let assertCmd = existing?.assertCmd
  if (input.assertCmd !== undefined) {
    assertCmd = input.assertCmd === null ? undefined : (String(input.assertCmd).trim().slice(0, 4000) || undefined)
  }
  // notify: 声明这个 job 会向渠道推送 ⇒ scheduler 跟踪其交付。
  //   { channel: 'feishu', require: false }
  //   presence = 跟踪（把 .sent 派生成台账里的 push 字段 + status 路由可见）
  //   require: true = 交付缺失即判本次运行失败并可重试（默认关：先观测遵守率，
  //   避免"模型没按 key 调用"把机制本身变成重复推送源）。null 清除。
  // deliveryKey: 交付/幂等键模板（事件域）。未配 = 用 runKey（槽位域，旧行为）。
  // 见 computeDeliveryKey 的长注释：这是"一次真实事件只推一条"的关键。
  let deliveryKey = existing?.deliveryKey
  if (input.deliveryKey !== undefined) {
    if (input.deliveryKey === null) {
      deliveryKey = undefined
    } else {
      const text = String(input.deliveryKey).trim().slice(0, 200)
      deliveryKey = text === '' ? undefined : text
    }
  }
  let notify = existing?.notify
  if (input.notify !== undefined) {
    if (input.notify === null) {
      notify = undefined
    } else if (typeof input.notify === 'object') {
      const channel = String(input.notify.channel ?? 'feishu').trim() || 'feishu'
      notify = { channel, require: input.notify.require === true }
    } else {
      throw new Error('notify must be an object {channel, require?} or null')
    }
  }
  return {
    name, prompt, trigger, workspace, enabled,
    ...(deliverTo ? { deliverTo } : {}),
    ...(catchUpPolicy ? { catchUpPolicy } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
    ...(model ? { model } : {}),
    ...(assertCmd ? { assertCmd } : {}),
    ...(notify ? { notify } : {}),
    ...(deliveryKey ? { deliveryKey } : {}),
  }
}

/** Validate a fallback chain: array of {provider, model, reasoningEffort?}. */
function normalizeModelChain(fallback) {
  if (fallback === undefined || fallback === null) return []
  if (!Array.isArray(fallback)) throw new Error('model.fallback must be an array of {provider, model}')
  const out = []
  for (const entry of fallback) {
    if (!entry || typeof entry !== 'object') throw new Error('model.fallback entries must be objects')
    const provider = String(entry.provider ?? '').trim()
    const mdl = String(entry.model ?? '').trim()
    if (provider === '' || mdl === '') throw new Error('model.fallback entries need provider and model')
    const reasoningEffort = entry.reasoningEffort !== undefined ? String(entry.reasoningEffort).trim() : undefined
    out.push({ provider, model: mdl, ...(reasoningEffort ? { reasoningEffort } : {}) })
  }
  return out
}

/**
 * Model for a given attempt: attempt 1 → primary; attempts ≥2 → last fallback
 * entry when one is declared (stay on the fallback once switched), else primary.
 */
export function selectModelForAttempt(model, attempt) {
  if (!model) return null
  const chain = [model, ...(model.fallback ?? [])]
  const idx = attempt <= 1 ? 0 : Math.min(attempt - 1, chain.length - 1)
  return chain[idx]
}

// ---- cordis plugin ----------------------------------------------------------

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const inflight = new Map() // jobId -> runId
  /**
   * jobId -> 最近一次渠道推送结果（内存投影，供 /scheduler/status 查询）。
   * 不读台账是为了让状态路由保持 O(1)：它会被探针按秒级轮询，而 runs.jsonl
   * 已经 2MB+，每次探测都全量解析不划算。重启后为空（可接受：这是观测便利，
   * 权威仍在 runs.jsonl 的 finish 行 `push` 字段）。
   */
  const pushState = new Map()
  /** jobId -> fireAt(ms): a due scheduled occurrence waiting out its dispatch jitter. */
  const jitterPending = new Map()
  const store = new Store(cfg.dataDir, {
    inflightProvider: () => new Set(inflight.values()),
    maxRuns: cfg.maxRuns,
  })
  let tickTimer
  let wakeTimer
  let lastTickAt = null
  let stopping = false

  const defaultEntry = resolveCliEntry()

  // Resolve the dsh CLI entry. Discovery order:
  //   1. explicit cfg.harnessDir (config or DSH_HARNESS_DIR): source checkout
  //      (apps/cli/lib/bin.js, or apps/cli/src/bin.ts via tsx) or a package
  //      root containing lib/bin.js (profile install shape)
  //   2. ~/.dsh/source/current  — harness source checkout convention
  //   3. $DSH_HOME/profiles/node_modules/@deepseek-ai/dsh  — profile install
  //   4. 都解析不到 ⇒ 返回 null（由 preflightExecution 报错，并带上 DSH_HARNESS_DIR / harnessDir 的补救指引）
  function resolveCliEntry() {
    const dshHome = process.env.DSH_HOME ?? `${homedir()}/.dsh`
    const candidates = []
    if (cfg.harnessDir) candidates.push(cfg.harnessDir)
    candidates.push(join(dshHome, 'source/current'))
    candidates.push(join(dshHome, 'profiles/node_modules/@deepseek-ai/dsh'))

    for (const root of candidates) {
      if (!root || !existsSync(root)) continue
      const bundled = join(root, 'apps/cli/lib/bin.js')
      if (existsSync(bundled)) return { args: [bundled], source: `lib@${root}` }
      const tsx = join(root, 'node_modules/tsx/esm')
      const tsEntry = join(root, 'apps/cli/src/bin.ts')
      if (existsSync(tsx) && existsSync(tsEntry)) {
        return { args: ['--import', tsx, tsEntry], source: `tsx@${root}` }
      }
      const pkgBin = join(root, 'lib/bin.js')
      if (existsSync(pkgBin)) return { args: [pkgBin], source: `profile@${root}` }
    }

    // 不抛：解析失败交给 preflightExecution（每次运行记一行失败、可见可排障）。
    // 在 apply() 里 eager 抛异常会拖掉整棵 web 插件树（dsh-multimedia 2026-08-15 事故同款），
    // 而调度器本来就有一条"花钱前先验前置"的通道，没理由绕过它。
    return null
  }

  // ---- executor -------------------------------------------------------------

  /**
   * Per-run model override: copy the user settings.yaml, replace the
   * agent-default-model section with the job's selection, and write a tiny
   * cordis patch that points the settings-file row at the copy. Headless
   * inherits the harness-wide settings doc, so an in-place edit would leak
   * into concurrent runs and the web host — a private copy keeps the override
   * scoped to exactly this run. Returns null when the job has no model or the
   * source cannot be patched safely (the run then uses the default model).
   */
  function prepareModelOverride(model, runId) {
    const tmpDir = join(cfg.dataDir, 'tmp')
    const patchPath = join(tmpDir, `patch-${runId}.yml`)
    let text
    try {
      text = renderModelOverridePatch(model)
    } catch {
      // provider/model 不合法 ⇒ 明确降级为"用默认模型"，而不是写一个坏 patch。
      return null
    }
    try {
      mkdirSync(tmpDir, { recursive: true })
      writeFileSync(patchPath, text, { mode: 0o600 })
    } catch {
      try { unlinkSync(patchPath) } catch { /* ignore */ }
      return null
    }
    return { patchPath }
  }

  function cleanupModelOverride(ov) {
    if (!ov) return
    // patchPath 是唯一产物（2026-10-09 起不再有 settings-<runId>.yaml 中间文件）
    try { unlinkSync(ov.patchPath) } catch { /* ignore */ }
  }

  function cleanupStaleOverrides() {
    try {
      const tmpDir = join(cfg.dataDir, 'tmp')
      if (!existsSync(tmpDir)) return
      for (const f of readdirSync(tmpDir)) {
        if (f.startsWith('settings-') || f.startsWith('patch-')) {
          try { unlinkSync(join(tmpDir, f)) } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  function runJob(job, triggerKind, scheduledFor, attempt = 1) {
    if (inflight.has(job.id)) {
      store.appendRun({
        id: newId('run'), jobId: job.id, triggerKind, scheduledFor, attempt, evt: 'skipped',
        status: 'skipped', startedAt: nowIso(), completedAt: nowIso(),
        error: 'already running',
      })
      return
    }
    if (inflight.size >= cfg.maxConcurrent) {
      store.appendRun({
        id: newId('run'), jobId: job.id, triggerKind, scheduledFor, attempt, evt: 'skipped',
        status: 'skipped', startedAt: nowIso(), completedAt: nowIso(),
        error: `concurrency limit (${cfg.maxConcurrent}) reached`,
      })
      return
    }

    const workspace = job.workspace || cfg.defaultWorkspace
    const preflightError = preflightExecution(defaultEntry, workspace)
    if (preflightError) {
      const timestamp = nowIso()
      store.appendRun({
        id: newId('run'), jobId: job.id, triggerKind, scheduledFor, attempt,
        evt: 'finish', status: 'failed', startedAt: timestamp, completedAt: timestamp,
        error: preflightError, retryable: false,
      })
      ctx.logger.error(`[dsh-scheduler] ${preflightError} for job "${job.name}" (${job.id}); retry skipped`)
      return
    }

    const runId = newId('run')
    const startedAt = nowIso()
    inflight.set(job.id, runId)
    // Dispatch latency: how late the run actually started against its scheduled
    // instant. Recorded so host-asleep drift (macOS Clamshell Sleep defers Node
    // timers to the next dark wake — measured 18-35 min on 9 mornings, 2026-09-12
    // audit) is visible in the ledger instead of hidden behind a green status.
    const scheduledMs = Date.parse(scheduledFor)
    const dispatchLatencyMs = Number.isFinite(scheduledMs) ? Math.max(0, Date.now() - scheduledMs) : undefined
    // 幂等键 + 子进程环境：agent 侧（headless 里只有 bash，没有 channel 工具）
    // 用 $DSH_SCHED_RUN_KEY 作 feishu-push.sh --key，于是**同一次触发的所有
    // attempt 共用一个 key**，重试/自我纠正都推不出第二条（脚本层 claim→send→commit）。
    // 同时把 runKey 写进 start/finish 台账，交付事实可按 key 反查。
    const runKey = computeRunKey(job.id, scheduledFor)
    // 交付键：默认 = runKey（槽位域，旧行为）；job 配了 deliveryKey 模板则用事件域键
    // （手动/补跑触发同一事件时键不变 ⇒ 幂等成立）。见 computeDeliveryKey 的长注释。
    const deliveryKey = computeDeliveryKey(job, runKey, scheduledFor)
    const runEnv = {
      ...process.env,
      DSH_SCHED_JOB_ID: job.id,
      DSH_SCHED_RUN_KEY: runKey,
      DSH_SCHED_DELIVERY_KEY: deliveryKey,
      DSH_SCHED_SCHEDULED_FOR: String(scheduledFor ?? ''),
      DSH_SCHED_ATTEMPT: String(attempt),
      DSH_SCHED_DELIVERY_STATE_DIR: cfg.deliveryStateDir,
    }
    const run = {
      id: runId, jobId: job.id, triggerKind, scheduledFor, attempt, evt: 'start', status: 'running', startedAt,
      runKey, deliveryKey,
      ...(dispatchLatencyMs !== undefined && attempt === 1 ? { dispatchLatencyMs } : {}),
    }
    store.appendRun(run)
    if (dispatchLatencyMs !== undefined && attempt === 1 && dispatchLatencyMs > 5 * 60_000) {
      ctx.logger.warn(
        `[dsh-scheduler] run ${runId} dispatched ${(dispatchLatencyMs / 60_000).toFixed(1)}min late `
        + `for job "${job.name}" (${job.id}); scheduled ${scheduledFor} — host was asleep or blocked`,
      )
    }
    ctx.logger.info(
      `[dsh-scheduler] fire job "${job.name}" (${job.id}) run=${runId} trigger=${triggerKind}`
      + `${runKey ? ` runKey=${runKey}` : ''}`,
    )

    // Dispatch-time accounting: advance nextRunAt *now*, before the run
    // settles. If the host crashes after dispatch, the restarted scheduler
    // sees an already-advanced nextRunAt and catch-up will NOT re-fire this
    // occurrence — the missing piece behind the 2026-08-18 fire→crash→
    // restart→refire loop (the crash happened before applyRunResult could
    // persist the advance). Manual triggers do not consume the schedule.
    if (triggerKind === 'scheduled') {
      const live = store.getJob(job.id)
      if (live) {
        const next = computeNextRun(live, Date.now())
        store.upsertJob({
          ...live,
          lastRunAt: startedAt,
          nextRunAt: next ? new Date(next).toISOString() : null,
          updatedAt: startedAt,
        })
      }
    }

    try { mkdirSync(workspace, { recursive: true }) } catch { /* spawn will fail with a clear error */ }
    const startedMs = Date.now()
    let output = ''
    let settled = false
    let timedOut = false

    // Timeout escalation: SIGTERM at timeoutMs, SIGKILL after killGraceMs.
    const killTimers = { term: undefined, kill: undefined }
    const clearKillTimers = () => {
      clearTimeout(killTimers.term)
      clearTimeout(killTimers.kill)
    }
    killTimers.term = setTimeout(() => {
      if (settled) return
      timedOut = true
      ctx.logger.warn(`[dsh-scheduler] run ${runId} timed out after ${cfg.timeoutMs}ms; SIGTERM sent`)
      child.kill('SIGTERM')
      killTimers.kill = setTimeout(() => {
        if (settled) return
        ctx.logger.warn(`[dsh-scheduler] run ${runId} still alive ${cfg.killGraceMs}ms after SIGTERM; SIGKILL sent`)
        child.kill('SIGKILL')
      }, cfg.killGraceMs)
    }, cfg.timeoutMs)

    // Per-job model override: private settings copy + patch, scoped to this run.
    // attempt 1 runs the primary model; later attempts fall back along the
    // declared chain (see selectModelForAttempt), so a free primary channel
    // that fails transiently retries on the paid fallback instead of failing.
    const runModel = selectModelForAttempt(job.model, attempt)
    const modelOverride = runModel ? prepareModelOverride(runModel, runId) : null
    if (modelOverride) {
      ctx.logger.info(
        `[dsh-scheduler] run ${runId} model override ${runModel.provider}/${runModel.model}`
        + (runModel.reasoningEffort ? ` (${runModel.reasoningEffort})` : '')
        + (attempt > 1 ? ` attempt=${attempt}` : ''),
      )
    }

    // prompt 里的 runKey 占位符在此替换：这是 runKey 到达 agent（进而到达
    // feishu-push.sh --key）的**唯一可靠通道**——bash 工具的环境由 shellEnv
    // registry 重建，不继承进程 env（见 RUN_KEY_PLACEHOLDER 注释）。
    const child = spawn(process.execPath, [
      ...defaultEntry.args, '--profile', 'headless',
      ...(modelOverride ? ['--patch', modelOverride.patchPath] : []),
      renderPrompt(job.prompt, runKey, deliveryKey),
    ], {
      cwd: workspace,
      env: runEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (d) => { output = tail(output + d.toString('utf8')) })
    child.stderr.on('data', (d) => { output = tail(output + d.toString('utf8')) })
    child.on('error', (error) => {
      if (settled) return
      clearKillTimers()
      finish({ status: 'failed', error: `spawn: ${renderThrown(error)}` })
    })
    child.on('close', (code, signal) => {
      if (settled) return
      clearKillTimers()
      if (timedOut) {
        finish({ status: 'failed', exitCode: code ?? -1, error: `timeout after ${Math.round(cfg.timeoutMs / 1000)}s` })
      } else if (signal) {
        finish({ status: 'failed', error: `killed by ${signal}` })
      } else if (code === 0) {
        // exit 0 only means the headless process finished cleanly — it says
        // nothing about whether the job actually delivered. An optional
        // assertCmd is the job's own mechanical acceptance test (2026-09-12
        // audit: the feed job reported 15 "succeeded" runs with zero output).
        runAssert().then((assertion) => {
          if (settled) return
          if (assertion && !assertion.ok) {
            ctx.logger.error(
              `[dsh-scheduler] run ${runId} assert FAILED (exit ${assertion.exitCode}) for job "${job.name}" (${job.id}): `
              + (assertion.output || '(no output)').slice(0, 300),
            )
            finish({
              status: 'failed',
              exitCode: 0,
              assertFailed: true,
              assertExitCode: assertion.exitCode,
              error: `assert failed (exit ${assertion.exitCode}): ${assertion.output || '(no output)'}`.slice(0, 500),
            })
            return
          }
          finish({ status: 'succeeded', exitCode: 0, ...(assertion ? { assertExitCode: 0 } : {}) })
        }).catch((error) => {
          if (settled) return
          finish({ status: 'succeeded', exitCode: 0, assertError: renderThrown(error) })
        })
      } else {
        finish({ status: 'failed', exitCode: code ?? -1 })
      }
    })

    /**
     * Run the job's mechanical acceptance test (job.assertCmd) after a clean
     * exit. Returns null when no assertion is declared, else
     * { ok, exitCode, output }. Assert failures are treated as NON-retryable
     * (deterministic condition; a retry would re-run side effects such as an
     * already-sent notification) but still count toward the failure streak.
     */
    function runAssert() {
      const cmd = String(job.assertCmd ?? '').trim()
      if (!cmd) return Promise.resolve(null)
      return new Promise((resolve) => {
        let out = ''
        let done = false
        let child
        try {
          child = spawn('/bin/bash', ['-lc', cmd], {
            cwd: workspace,
            env: runEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        } catch (error) {
          resolve({ ok: false, exitCode: -1, output: `assert spawn: ${renderThrown(error)}` })
          return
        }
        const timer = setTimeout(() => {
          if (done) return
          done = true
          try { child.kill('SIGKILL') } catch { /* ignore */ }
          resolve({ ok: false, exitCode: -1, output: `assert timeout after ${Math.round(cfg.assertTimeoutMs / 1000)}s` })
        }, cfg.assertTimeoutMs)
        const push = (d) => { out = tail(out + d.toString('utf8')) }
        child.stdout.on('data', push)
        child.stderr.on('data', push)
        child.on('error', (error) => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve({ ok: false, exitCode: -1, output: `assert spawn: ${renderThrown(error)}` })
        })
        child.on('close', (code) => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve({ ok: code === 0, exitCode: code ?? -1, output: out.trim() })
        })
      })
    }

    function finish(result) {
      // Containment: any bug in finish's bookkeeping (e.g. the 2026-08-18
      // `delivery` ReferenceError, or a throwing logger) must never take down
      // the whole web host. State that can be written is written inside the
      // try; on exception we log, clear inflight, and let the next tick retry.
      try {
        settled = true
        cleanupModelOverride(modelOverride)
        if (!inflight.has(job.id) || inflight.get(job.id) !== runId) return
        inflight.delete(job.id)
      // 交付事实（2026-10-03 复盘）：job 声明了 notify 才跟踪。必须在判定
      // willRetry 之前算出来，require 门禁才能参与成败判定。
      // 权威来源是 push 脚本的状态文件（脚本才是发送方），scheduler 只派生；
      // 三态：.sent=delivered / .skipped=有意不推送（合法）/ 都没有=missing。
      const pushSent = job.notify ? readDeliveryRecord(cfg.deliveryStateDir, deliveryKey) : null
      const pushSkipped = job.notify && !pushSent ? readSkipRecord(cfg.deliveryStateDir, deliveryKey) : null
      const pushRecord = pushSent ?? pushSkipped
      // 「交付恰好一次」（2026-10-06）：runKey 就是 jobId|scheduledFor，key 幂等本应让同一
      // 次触发只可能有一条交付事实。台账里已有同 key 的 delivered 事件却又出现一条 ⇒
      // 发送方绕开了 key（例如 prompt 里换了自定义 --key），属真重复，必须红且**不重试**
      // （重试只会再发一次）。
      if (pushSent) {
        // 事件域交付键下，同一次真实事件的多次触发都会看到同一个 .sent 并各写一条 delivered
        // 事件 ⇒ **按条数判会误判**。真正的重复 = 同一个键真的发出去两条，其特征是 .sent 的
        // messageId 变了（脚本 dedup 时不重写 .sent；只有绕过 key/--force 才变）。
        const priorIds = store.deliveredMessageIds(deliveryKey)
        const distinct = new Set(priorIds)
        if (pushSent.messageId) distinct.add(pushSent.messageId)
        if (distinct.size > 1) {
          result = {
            ...result,
            status: 'failed',
            deliveryDuplicate: true,
            error: `delivery duplicated for key "${deliveryKey}"（该键出现过 ${distinct.size} 个不同 messageId；runKey=${runKey}）`,
          }
        }
      }
      // 交付越界：本次 run 写了别的键 ⇒ agent 自造 key，**当次即红且不重试**
      // （重试只会再发一条；已发出的那条只能靠事后清理与审计聚类追踪）。
      if (job.notify) {
        const sinceMs = Number.isFinite(Date.parse(startedAt)) ? Date.parse(startedAt) : Date.now()
        const strays = findStrayDeliveries(cfg.deliveryStateDir, deliveryKey, sinceMs)
        if (strays.length > 0) {
          result = {
            ...result,
            status: 'failed',
            deliveryStray: true,
            error: `delivery stray keys during this run: ${strays.join(', ')}（交付键应为 ${deliveryKey}；agent 自造 key 会导致一次触发多条推送）`,
          }
        }
      }
      if (job.notify?.require === true && result.status === 'succeeded' && !pushRecord) {
        // 交付门禁：脚本层既没有该 runKey 的 .sent 也没有 .skipped ⇒ 这次触发**该发
        // 而没发**。记 failed 且 **允许重试**——重试会再跑一遍 prompt，而标记仍然
        // 缺失，所以补发不会被
        // 脚本层当成重复；反过来若已送达，.sent 在，重试也推不出第二条。
        result = {
          ...result,
          status: 'failed',
          deliveryMissing: true,
          error: `delivery missing for key "${deliveryKey}"（在 ${cfg.deliveryStateDir} 找不到 .sent；runKey=${runKey}）`,
        }
      }
      const completedAt = nowIso()
      const durationMs = Date.now() - startedMs
      const maxAttempts = job.maxAttempts ?? cfg.maxAttempts
      const retryDelay = job.retryDelayMs ?? cfg.retryDelayMs
      const failed = result.status !== 'succeeded'
      // Assert failures are deterministic: retrying would just re-run the same
      // side effects (including any notification already sent) without fixing
      // the condition. They still count toward the failure streak/alert.
      const willRetry = failed && !result.assertFailed && !result.deliveryDuplicate && shouldRetry(job, cfg, result.status, output, attempt)
      const finalRun = {
        ...run,
        ...result,
        evt: 'finish',
        durationMs,
        outputHead: output,
        completedAt,
      }
      if (willRetry) {
        finalRun.error = (finalRun.error ? `${finalRun.error}; ` : '')
          + `[attempt ${attempt}/${maxAttempts}] retrying in ${Math.round(retryDelay / 1000)}s`
      } else if (failed && attempt > 1) {
        finalRun.error = (finalRun.error ? `${finalRun.error}; ` : '')
          + `[attempt ${attempt}/${maxAttempts}] gave up`
      }
      // 交付写进台账（与 deliverTo 的 `delivery` 字段区分开：那是"投递到目标
      // 会话"，这里是"推送到渠道"。两条链路的失败模式完全不同，不能共用一个字段）。
      if (job.notify) {
        finalRun.push = pushSent
          ? { status: 'delivered', ...pushSent }
          : pushSkipped
            ? { status: 'skipped', ...pushSkipped }
            : { status: 'missing', channel: job.notify.channel ?? 'feishu', key: deliveryKey }
        pushState.set(job.id, { ...finalRun.push, runId, at: completedAt })
        // 交付事实写成**独立 side 事件**（evt:'delivered'）：台账从此能机械回答
        // 「这个 runKey 交付了几次」（store.listRuns 折叠时把它当 side event，不参与
        // 状态折叠；countDeliveredEvents 供恰好一次门禁使用）。只在真有交付事实
        // （.sent 或 .skipped）时写，missing 不写——missing 由 finish 的 push 字段与
        // require 门禁表达。
        if (pushRecord) {
          store.appendRun({
            id: runId, jobId: job.id, triggerKind, scheduledFor, attempt,
            evt: 'delivered',
            deliveryKey,
            deliveryStatus: pushSent ? 'delivered' : 'skipped',
            // messageId 是"这个键到底发出去几条"的可观测特征（脚本 dedup 时不重写 .sent）
            ...(pushSent?.messageId ? { messageId: pushSent.messageId } : {}),
            channel: job.notify.channel ?? 'feishu',
            startedAt, completedAt,
          })
        }
      }
      // Defer delivery (target-session notification) until the final outcome.
      // NOTE: `delivery` must be function-scoped — the success log below
      // references it, and a block-scoped const here crashed the whole web
      // host on every successful run (ReferenceError), which combined with
      // catch-up semantics caused an infinite fire→crash→restart→refire loop.
      let delivery
      if (!willRetry) {
        delivery = deliver(job, finalRun)
        if (delivery) finalRun.delivery = delivery
      }
      store.appendRun(finalRun)
      ctx.logger.info(
        `[dsh-scheduler] run ${runId} ${result.status} for job "${job.name}" (${job.id})`
        + ` attempt=${attempt}/${maxAttempts}`
        + ` in ${((Date.now() - startedMs) / 1000).toFixed(1)}s${delivery ? ` delivery=${delivery.status}` : ''}`,
      )

      const live = store.getJob(job.id)
      if (!live) {
        scheduleWake()
        return
      }
      if (willRetry) {
        // Persisted retry state: the tick loop owns the retry timing, so a web
        // restart between attempts does not lose the retry and the job cannot
        // double-fire while waiting (retryState branch runs before the normal
        // due check; nextRunAt points at the retry instant).
        const until = new Date(Date.now() + retryDelay).toISOString()
        store.upsertJob({
          ...live,
          retryState: { attempt: attempt + 1, triggerKind, scheduledFor, until },
          nextRunAt: until,
          updatedAt: nowIso(),
        })
        ctx.logger.warn(
          `[dsh-scheduler] run ${runId} failed (attempt ${attempt}/${maxAttempts}); `
          + `retry scheduled in ${Math.round(retryDelay / 1000)}s for job "${job.name}" (${job.id})`,
        )
        scheduleWake()
        return
      }
      const updated = applyRunResult(live, result, cfg, completedAt)
      store.upsertJob(updated)
      if (updated.state === 'paused' && updated.pausedReason === 'max_consecutive_failures') {
        ctx.logger.warn(
          `[dsh-scheduler] job "${job.name}" (${job.id}) auto-paused after `
          + `${updated.consecutiveFailures} consecutive failures (max ${cfg.maxConsecutiveFailures})`,
        )
      }
      // Failure alert: final failure (no retry) crossing the threshold, once
      // per failure streak (alertedFailures watermark). Fire-and-forget push
      // through ~/.dsh/scripts/feishu-push.sh; never blocks or throws (any
      // exception here must not take down the web host — scheduler 2026-08-18
      // crash-loop precedent).
      if (!willRetry && result.status !== 'succeeded' && cfg.alertOnConsecutiveFailures > 0
          && updated.consecutiveFailures >= cfg.alertOnConsecutiveFailures
          && (live.alertedFailures ?? 0) < updated.consecutiveFailures) {
        store.upsertJob({ ...updated, alertedFailures: updated.consecutiveFailures })
        pushFailureAlert(job, updated, finalRun, attempt, maxAttempts)
      }
      scheduleWake()
      } catch (error) {
        settled = true
        if (inflight.has(job.id) && inflight.get(job.id) === runId) inflight.delete(job.id)
        try {
          ctx.logger.error(
            `[dsh-scheduler] finish() crashed for run ${runId} (job "${job.name}" ${job.id}): ${renderThrown(error)}`,
          )
        } catch {
          console.error('[dsh-scheduler] finish() crashed:', error)
        }
      }
    }
  }

  /** Deliver the run outcome into the job's target session (live root agent). */
  function deliver(job, run) {
    const target = job.deliverTo?.sessionId
    if (!target) return undefined
    try {
      const agent = ctx.agents.get(target)
      const isRoot = agent !== undefined && ctx.agents.roots().includes(agent)
      if (!isRoot) {
        ctx.logger.warn(`[dsh-scheduler] delivery skipped: target session ${target} not live`)
        return { status: 'skipped', reason: 'target session not live' }
      }
      const message = createUserMessage({
        content: [{ type: 'text', text: renderDelivery(job, run) }],
        source: { kind: 'plugin', plugin: 'dsh-scheduler' },
      })
      agent.followup(message)
      return { status: 'delivered', sessionId: target }
    } catch (error) {
      ctx.logger.warn(`[dsh-scheduler] delivery failed: ${renderThrown(error)}`)
      return { status: 'error', reason: renderThrown(error) }
    }
  }

  /**
   * Push a failure alert to Feishu via the push script. Fire-and-forget:
   * spawns bash, never awaits, never throws. The script path is configurable
   * through env DSH_SCHEDULER_ALERT_SCRIPT for test/override.
   */
  // ── 告警文案（2026-10-07 按「消息文案契约」重写）──────────────────────────
  // 见 FEISHU-MESSAGE-COPY-REVIEW-2026-10-07.md §2.1。旧版把 job id、attempt、
  // 原始 error（含 delivery key 与 .sent 绝对路径）、以及**最后 300 字的模型输出**
  // （实测是一整段英文自述推理）一起塞进 500 字上限，末尾被截断，且完全没有
  // 「要不要动手」。新契约：第 1 行结论 → 2..4 行证据 → 动作行。
  // 每条 = [匹配, 人话原因, 重试能否自愈]。第三项决定动作行 —— 说「不会自愈」
  // 却写「会自动重试」是自相矛盾的（2026-10-07 复算时抓到）。
  const ALERT_ERROR_HINTS = [
    [/delivery missing/i, '推送之后没留下投递记录，调度器据此判定「没发出去」', true],
    [/ERR_MODULE_NOT_FOUND|Cannot find package/i, '运行环境缺依赖（重试不会自愈）', false],
    [/not supported|unavailable|AUTH: 40[13]/i, '模型不可用（重试不会自愈）', false],
    [/timed? ?out|ETIMEDOUT|timeout of/i, '执行超时', true],
    [/assert|missing or empty/i, '报告校验没通过', true],
    [/DEVICE_OFFLINE/i, '采集设备离线', true],
  ]
  function humanizeRunError(error) {
    const raw = String(error ?? '').trim()
    if (!raw) return { reason: null, selfHealing: true }
    for (const [re, text, selfHealing] of ALERT_ERROR_HINTS) {
      if (re.test(raw)) return { reason: text, selfHealing }
    }
    // 兜底：抹掉引号里的长内部键（delivery key / .sent 路径），只留第一句
    return {
      reason: raw.replace(/"[^"]{16,}"/g, '…').replace(/（在 [^）]*）/g, '').split(/[;；]/)[0].slice(0, 80),
      selfHealing: true,
    }
  }
  /** job 名字常带时间表（「…（微博+X → Win，每日 08:35/13:35/21:35）」）：
   *  告警头行不需要它，而它一占就是三四十字。 */
  function jobShortName(name) {
    return String(name ?? '').replace(/[（(][^）)]*[）)]\s*$/, '').trim() || String(name ?? '')
  }
  function fmtLocalTime(iso) {
    if (!iso) return null
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return null
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  function pushFailureAlert(job, updated, run, attempt, maxAttempts) {
    const script = process.env.DSH_SCHEDULER_ALERT_SCRIPT
      ?? `${homedir()}/.dsh/scripts/feishu-push.sh`
    if (!existsSync(script)) {
      ctx.logger.warn(`[dsh-scheduler] failure alert skipped: ${script} not found`)
      return
    }
    // 去掉旧版的 `- 输出: <模型输出尾部 300 字>`：那是**推理过程**不是结论，实测带进
    // 整段英文（"So sandbox blocked the tmp write. … which is the desired behavior."，
    // 见 COPY-REVIEW §2.1 C4）。原文仍可在 runs.jsonl / 报告里查。
    // job id / attempt 明细 / delivery key / .sent 路径同样降级到台账。
    const gaveUp = attempt >= maxAttempts
    const when = fmtLocalTime(run.scheduledFor ?? run.startedAt)
    const { reason, selfHealing } = humanizeRunError(run.error)
    const text = [
      `🔴 定时任务连败：${jobShortName(job.name)}（${updated.consecutiveFailures} 次）`,
      `· 最近一次${when ? ` ${when}` : ''}，`
        + (gaveUp ? `重试 ${attempt}/${maxAttempts} 次已用尽` : `第 ${attempt}/${maxAttempts} 次尝试`),
      reason ? `· 原因：${reason}` : null,
      !selfHealing ? '→ 重试不会自愈，需要看一眼'
        : (gaveUp ? '→ 本次不再重试，需要看一眼' : '→ 无需动手，会自动重试'),
    ].filter(Boolean).join('\n')
    // 告警也走幂等键：key 含 job + 触发时刻 + 失败链长度。同一次触发的告警
    // 只发一条（水位已挡重发，这里再挡一层"重启/重试窗口内水位未落盘"的重复；
    // 失败链变长 ⇒ 新 key ⇒ 能继续升级告警，不会被误吞）。
    const alertKey = `${job.id}|${run.scheduledFor}|alert|${updated.consecutiveFailures}`
    try {
      const child = spawn('bash', [script, '--key', alertKey, '--max-chars', '500', text], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, FEISHU_PUSH_STATE_DIR: cfg.deliveryStateDir },
      })
      child.stderr.on('data', (d) => {
        ctx.logger.warn(`[dsh-scheduler] failure alert stderr: ${String(d).slice(0, 200)}`)
      })
      child.on('error', (error) => {
        ctx.logger.warn(`[dsh-scheduler] failure alert push failed: ${renderThrown(error)}`)
      })
      child.on('close', (code) => {
        ctx.logger.info(
          `[dsh-scheduler] failure alert pushed for "${job.name}" (${job.id}) `
          + `consecutive=${updated.consecutiveFailures} exit=${code}`,
        )
      })
    } catch (error) {
      ctx.logger.warn(`[dsh-scheduler] failure alert push error: ${renderThrown(error)}`)
    }
  }

  // ---- scheduler loop -------------------------------------------------------

  function tick() {
    if (stopping) return
    if (!store.acquireLock()) return // another instance is ticking
    try {
      lastTickAt = new Date().toISOString()
      const now = Date.now()
      const jobs = store.loadJobs()
      for (const job of jobs) {
        if (job.enabled === false || job.state === 'paused' || job.state === 'completed') continue
        // Never re-dispatch a job whose run is in flight: without this, a due
        // job would have a skipped "already running" record appended on every
        // tick while the run is active (ledger spam; observed 29x on 08-18).
        if (inflight.has(job.id)) continue
        const nowMs = Date.now()
        // Retry branch: a failed attempt left a persisted retryState. While
        // waiting, the job is skipped entirely (no double-fire). When the
        // `until` instant arrives, fire the next attempt.
        if (job.retryState) {
          if (Date.parse(job.retryState.until) > nowMs) continue
          const rs = job.retryState
          const live = store.getJob(job.id)
          if (live) store.upsertJob({ ...live, retryState: undefined, updatedAt: nowIso() })
          ctx.logger.info(
            `[dsh-scheduler] retry attempt ${rs.attempt} for job "${job.name}" (${job.id}) `
            + `trigger=${rs.triggerKind} scheduledFor=${rs.scheduledFor}`,
          )
          runJob({ ...job, retryState: undefined }, rs.triggerKind, rs.scheduledFor, rs.attempt)
          continue
        }
        if (!job.nextRunAt || Date.parse(job.nextRunAt) > nowMs) continue
        // Dispatch jitter: a due scheduled occurrence first waits out a random
        // delay in [0, jitterMax] (per-job trigger.jitterMaxMs, else the global
        // dispatchJitterMaxMs; 0 disables). In-memory only: on host restart the
        // delay re-rolls, which is fine — jitter is a spread, not a contract.
        // Retry attempts and manual triggers bypass jitter (they call runJob
        // directly and never reach here with a fresh nextRunAt).
        const jitterMax = job.trigger?.jitterMaxMs ?? cfg.dispatchJitterMaxMs
        if (jitterMax > 0) {
          const pending = jitterPending.get(job.id)
          if (pending === undefined) {
            const fireAt = nowMs + Math.floor(Math.random() * jitterMax)
            jitterPending.set(job.id, fireAt)
            ctx.logger.info(
              `[dsh-scheduler] job "${job.name}" (${job.id}) due at ${job.nextRunAt} `
              + `waiting jitter +${Math.round((fireAt - nowMs) / 1000)}s`,
            )
            continue
          }
          if (pending > nowMs) continue
          jitterPending.delete(job.id)
        }
        const decision = decideCatchUp(job, cfg, nowMs)
        if (decision.action === 'skip') {
          const next = computeNextRun(job, now)
          store.appendRun({
            id: newId('run'), jobId: job.id, triggerKind: 'scheduled', scheduledFor: job.nextRunAt, evt: 'skipped',
            status: 'skipped', startedAt: nowIso(), completedAt: nowIso(),
            error: `catch-up skipped (late by ${Math.round(decision.latenessMs / 1000)}s > ${Math.round(cfg.maxLatenessMs / 1000)}s)`,
          })
          store.upsertJob({
            ...job,
            nextRunAt: next ? new Date(next).toISOString() : null,
            updatedAt: nowIso(),
          })
          ctx.logger.info(
            `[dsh-scheduler] job "${job.name}" (${job.id}) missed occurrence skipped `
            + `(late by ${Math.round(decision.latenessMs / 1000)}s, max ${Math.round(cfg.maxLatenessMs / 1000)}s)`,
          )
          continue
        }
        runJob(job, 'scheduled', job.nextRunAt)
      }
    } finally {
      store.releaseLock()
    }
    scheduleWake()
  }

  function scheduleWake() {
    if (stopping) return
    clearTimeout(wakeTimer)
    const now = Date.now()
    let earliest = null
    for (const job of store.loadJobs()) {
      if (job.enabled === false || job.state === 'paused' || job.state === 'completed' || !job.nextRunAt) continue
      const t = Date.parse(job.nextRunAt)
      if (earliest === null || t < earliest) earliest = t
    }
    // A jitter-pending occurrence must wake exactly when its random delay
    // elapses; otherwise we would busy-poll every 500ms while it waits.
    for (const fireAt of jitterPending.values()) {
      if (earliest === null || fireAt < earliest) earliest = fireAt
    }
    if (earliest === null) return
    const delay = Math.min(Math.max(earliest - now, 500), MAX_TIMER_DELAY_MS)
    wakeTimer = setTimeout(() => tick(), delay)
  }

  function start() {
    if (!defaultEntry) {
      ctx.logger.warn(
        `[dsh-scheduler] ${CLI_ENTRY_REMEDY}——插件已加载，但每次运行会在 preflight 阶段失败并记一行 failed`
        + '（不再让插件加载即抛异常拖掉整棵插件树）',
      )
    }
    ctx.logger.info(
      `[dsh-scheduler] started: dataDir=${cfg.dataDir} cli=${defaultEntry?.source ?? 'UNRESOLVED'} `
      + `maxConcurrent=${cfg.maxConcurrent} timeout=${Math.round(cfg.timeoutMs / 1000)}s `
      + `killGrace=${Math.round(cfg.killGraceMs / 1000)}s breaker=${cfg.maxConsecutiveFailures} `
      + `retry=${cfg.maxAttempts}x/${Math.round(cfg.retryDelayMs / 1000)}s `
      + `catchUp=${cfg.catchUpPolicy}${cfg.catchUpPolicy === 'skip' ? ` maxLateness=${Math.round(cfg.maxLatenessMs / 1000)}s` : ''} `
      + `jitter=${cfg.dispatchJitterMaxMs > 0 ? `${Math.round(cfg.dispatchJitterMaxMs / 1000)}s` : 'off'}`,
    )
    cleanupStaleOverrides()
    tick()
    tickTimer = setInterval(() => tick(), cfg.tickMs)
  }

  // ---- REST API -------------------------------------------------------------

  function sendJson(res, status, json) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(json, null, 2))
  }

  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      chunks.push(chunk)
      size += chunk.length
      if (size > 1_000_000) throw new Error('request body too large')
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return text ? JSON.parse(text) : {}
  }

  function respond(res, status, json) {
    sendJson(res, status, json)
  }

  async function routeStatus(res) {
    const jobs = store.loadJobs()
    respond(res, 200, {
      ok: true,
      lastTickAt,
      lockHeld: existsSync(store.lockPath),
      inflight: [...inflight.entries()].map(([jobId, runId]) => ({ jobId, runId })),
      jobCount: jobs.length,
      enabledCount: jobs.filter((j) => j.enabled && j.state !== 'paused' && j.state !== 'completed').length,
      dataDir: cfg.dataDir,
      harnessDir: cfg.harnessDir,
      cliEntry: defaultEntry?.source ?? null,
      cliError: defaultEntry ? null : CLI_ENTRY_REMEDY,
      maxConcurrent: cfg.maxConcurrent,
      timeoutMs: cfg.timeoutMs,
      killGraceMs: cfg.killGraceMs,
      tickMs: cfg.tickMs,
      maxConsecutiveFailures: cfg.maxConsecutiveFailures,
      maxAttempts: cfg.maxAttempts,
      retryDelayMs: cfg.retryDelayMs,
      catchUpPolicy: cfg.catchUpPolicy,
      maxLatenessMs: cfg.maxLatenessMs,
      maxRuns: cfg.maxRuns,
      assertTimeoutMs: cfg.assertTimeoutMs,
      dispatchJitterMaxMs: cfg.dispatchJitterMaxMs,
      // Per-job health: the fields an audit needs without opening the ledger —
      // how old the last run is, whether it is failing, and how late it
      // actually fired (macOS sleep drift is invisible otherwise).
      jobs: jobs.map((j) => ({
        id: j.id,
        name: j.name,
        enabled: j.enabled,
        state: j.state,
        trigger: j.trigger.kind === 'cron' ? j.trigger.expression : `${j.trigger.kind}:${j.trigger.expression}`,
        nextRunAt: j.nextRunAt ?? null,
        lastRunAt: j.lastRunAt ?? null,
        lastStatus: j.lastStatus ?? null,
        lastRunAgeMs: j.lastRunAt ? Date.now() - Date.parse(j.lastRunAt) : null,
        runCount: j.runCount ?? 0,
        consecutiveFailures: j.consecutiveFailures ?? 0,
        lastDispatchLatencyMs: j.lastDispatchLatencyMs ?? null,
        assertCmd: j.assertCmd ?? null,
      })),
    })
  }

  async function routeListJobs(res) {
    const jobs = store.loadJobs()
    respond(res, 200, { count: jobs.length, results: jobs })
  }

  async function routeCreateJob(res, req) {
    const input = await readBody(req)
    const fields = normalizeJob(input)
    const now = Date.now()
    const next = fields.enabled ? computeNextRun({ trigger: fields.trigger }, now) : null
    const job = {
      id: newId('job'),
      ...fields,
      state: fields.enabled ? (next === null ? 'completed' : 'scheduled') : 'paused',
      nextRunAt: next ? new Date(next).toISOString() : null,
      lastRunAt: null,
      lastStatus: null,
      runCount: 0,
      consecutiveFailures: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    store.upsertJob(job)
    scheduleWake()
    respond(res, 201, { job, occurrences: previewTrigger(fields.trigger.kind, fields.trigger.expression, fields.trigger.timezone, 5) })
  }

  async function routeGetJob(res, id) {
    const job = store.getJob(id)
    if (!job) return respond(res, 404, { code: 'not_found', message: `job ${id} not found` })
    respond(res, 200, { job })
  }

  async function routeUpdateJob(res, id, req) {
    const existing = store.getJob(id)
    if (!existing) return respond(res, 404, { code: 'not_found', message: `job ${id} not found` })
    const input = await readBody(req)
    const fields = normalizeJob(input, existing)
    const now = Date.now()
    const wasPaused = existing.state === 'paused' || existing.enabled === false
    const recompute = wasPaused || input.trigger !== undefined || input.prompt !== undefined || input.name !== undefined
    const next = fields.enabled
      ? (recompute ? computeNextRun({ trigger: fields.trigger }, now) : existing.nextRunAt ? Date.parse(existing.nextRunAt) : null)
      : existing.nextRunAt
    const job = {
      ...existing,
      ...fields,
      state: fields.enabled ? (next === null && fields.trigger.kind === 'once' ? 'completed' : 'scheduled') : 'paused',
      nextRunAt: next ? new Date(next).toISOString() : null,
      updatedAt: nowIso(),
    }
    // Explicit-clears: normalizeJob omits keys it cleared, but {...existing}
    // would then resurrect them — delete instead so null truly removes.
    if (input.model === null) delete job.model
    if (input.deliverTo === null) delete job.deliverTo
    if (input.assertCmd === null) delete job.assertCmd
    store.upsertJob(job)
    scheduleWake()
    respond(res, 200, { job })
  }

  async function routeDeleteJob(res, id) {
    if (!store.deleteJob(id)) return respond(res, 404, { code: 'not_found', message: `job ${id} not found` })
    scheduleWake()
    respond(res, 200, { id, deleted: true })
  }

  async function routeTriggerJob(res, id) {
    const job = store.getJob(id)
    if (!job) return respond(res, 404, { code: 'not_found', message: `job ${id} not found` })
    runJob(job, 'manual', nowIso())
    respond(res, 202, { id, accepted: true })
  }

  async function routePauseJob(res, id) {
    const job = store.getJob(id)
    if (!job) return respond(res, 404, { code: 'not_found', message: `job ${id} not found` })
    store.upsertJob({ ...job, enabled: false, state: 'paused', updatedAt: nowIso() })
    scheduleWake()
    respond(res, 200, { id, state: 'paused' })
  }

  async function routeResumeJob(res, id) {
    const job = store.getJob(id)
    if (!job) return respond(res, 404, { code: 'not_found', message: `job ${id} not found` })
    const now = Date.now()
    const next = computeNextRun(job, now)
    store.upsertJob({
      ...job,
      enabled: true,
      state: next === null && job.trigger.kind === 'once' ? 'completed' : 'scheduled',
      nextRunAt: next ? new Date(next).toISOString() : job.nextRunAt,
      updatedAt: nowIso(),
    })
    scheduleWake()
    respond(res, 200, { id, state: 'scheduled' })
  }

  async function routeJobRuns(res, id, url) {
    const limit = Number(url.searchParams.get('limit') ?? 50)
    // In-flight awareness comes from the store's inflightProvider.
    respond(res, 200, { jobId: id, runs: store.listRuns(id, Math.min(Math.max(limit, 1), 200)) })
  }

  async function routePreview(res, url) {
    const kind = url.searchParams.get('kind') ?? ''
    const expression = url.searchParams.get('expression') ?? ''
    const timezone = url.searchParams.get('timezone') ?? 'local'
    const n = Number(url.searchParams.get('n') ?? 5)
    try {
      const occurrences = previewTrigger(kind, expression, timezone, Math.min(Math.max(n, 1), 20))
      respond(res, 200, { trigger: { kind, expression, timezone }, occurrences })
    } catch (error) {
      respond(res, 400, { code: 'invalid_trigger', message: renderThrown(error) })
    }
  }

  // /plugins/<id>/status 统一约定（2026-08-23）：内部状态只读折叠（exact 独立路由）
  // ⚠️ 必须持有 disposer 并在生命周期清理里释放（2026-10-05 实证）：本行原先没有
  // 释放路径，config-only 重放时旧实例的这条路由残留，新实例注册即抛
  // "webserver: duplicate exact route \"/plugins/dsh-scheduler/status\""，整次
  // reapply 被放弃 ⇒ 旧实例的 prefix 路由（/scheduler，GUI tab 与 REST API 都走它）
  // 已被拆掉、tick 循环已停，而这条 status 路由仍用旧闭包应答（lastTickAt 冻结）
  // —— 表现为「调度器假活：状态接口 200，但任务永不再触发」。
  const disposeStatusRoute = ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/dsh-scheduler/status',
    handler: (_req, r) => {
      const jobs = store.loadJobs()
      respond(r, 200, {
        ok: true,
        plugin: 'dsh-scheduler',
        version: pluginVersion(),
        counts: {
          jobs: jobs.length,
          enabled: jobs.filter((j) => j.enabled && j.state !== 'paused' && j.state !== 'completed').length,
          inflight: inflight.size,
          failing: jobs.filter((j) => (j.consecutiveFailures ?? 0) > 0).length,
          // 交付面：跟踪投递的 job 数 / 最近一次**该发而没发**的 job 数 / 有意静默的
          // job 数。assertCmd 只看报告文件，这是唯一能看出「发了几条」的计数
          // （2026-10-03 复盘）。skipped 是合法状态，不能混进 missing。
          notifyJobs: jobs.filter((j) => j.notify).length,
          pushMissing: [...pushState.values()].filter((v) => v.status === 'missing').length,
          pushSkipped: [...pushState.values()].filter((v) => v.status === 'skipped').length,
        },
        lastError: null,
        detail: {
          lastTickAt,
          lockHeld: existsSync(store.lockPath),
          // CLI 解析诊断：解析失败时插件照常加载（不拖垮插件树），问题在这里与
          // 每次运行的 failed 台账行里可见 —— /plugins/<id>/status 是工具查询面。
          cliEntry: defaultEntry?.source ?? null,
          cliError: defaultEntry ? null : CLI_ENTRY_REMEDY,
          maxRuns: cfg.maxRuns,
          assertTimeoutMs: cfg.assertTimeoutMs,
          deliveryStateDir: cfg.deliveryStateDir,
          lastPush: Object.fromEntries(pushState),
          jobs: jobs.map((j) => ({
            id: j.id,
            name: j.name,
            state: j.state,
            enabled: j.enabled,
            nextRunAt: j.nextRunAt ?? null,
            lastRunAt: j.lastRunAt ?? null,
            lastStatus: j.lastStatus ?? null,
            lastRunAgeMs: j.lastRunAt ? Date.now() - Date.parse(j.lastRunAt) : null,
            consecutiveFailures: j.consecutiveFailures ?? 0,
            lastDispatchLatencyMs: j.lastDispatchLatencyMs ?? null,
            assertCmd: Boolean(j.assertCmd),
            notify: j.notify ?? null,
          })),
        },
      })
    },
  })

  const server = ctx.webServer.register({
    kind: 'prefix',
    path: '/scheduler',
    handler: async (req, r) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const method = req.method ?? 'GET'
      const parts = url.pathname.split('/').filter(Boolean) // [scheduler, jobs?, id?, action?]
      try {
        // 每条路由都必须 `return await`：这些 handler 都是 async，同步 `return promise`
        // 不会把 rejection 交给下面的 catch —— 校验失败（缺 name/坏 cron）会变成
        // 逃逸的 rejection（宿主侧表现为请求失败），而不是设计好的 400 invalid_input。
        if (method === 'GET' && (url.pathname === '/scheduler' || url.pathname === '/scheduler/status')) return await routeStatus(r)
        if (method === 'GET' && url.pathname === '/scheduler/jobs') return await routeListJobs(r)
        if (method === 'GET' && url.pathname === '/scheduler/preview') return await routePreview(r, url)
        if (method === 'POST' && url.pathname === '/scheduler/jobs') return await routeCreateJob(r, req)
        if (parts.length >= 3 && parts[0] === 'scheduler' && parts[1] === 'jobs') {
          const id = parts[2]
          const action = parts[3]
          if (!action && method === 'GET') return await routeGetJob(r, id)
          if (!action && method === 'PATCH') return await routeUpdateJob(r, id, req)
          if (!action && method === 'DELETE') return await routeDeleteJob(r, id)
          if (action === 'trigger' && method === 'POST') return await routeTriggerJob(r, id)
          if (action === 'pause' && method === 'POST') return await routePauseJob(r, id)
          if (action === 'resume' && method === 'POST') return await routeResumeJob(r, id)
          if (action === 'runs' && method === 'GET') return await routeJobRuns(r, id, url)
        }
        return respond(r, 404, { code: 'not_found', message: `${method} ${url.pathname}` })
      } catch (error) {
        const status = error instanceof CronParseError || /required|invalid|too large/.test(renderThrown(error)) ? 400 : 500
        return respond(r, status, { code: status === 400 ? 'invalid_input' : 'internal_error', message: renderThrown(error) })
      }
    },
  })

  ctx.effect(() => {
    start()
    return () => {
      stopping = true
      clearInterval(tickTimer)
      clearTimeout(wakeTimer)
      server()
      disposeStatusRoute()
      // Let in-flight headless children exit naturally; the web drain owns the
      // process boundary.
    }
  }, 'dsh-scheduler.lifecycle()')
}
