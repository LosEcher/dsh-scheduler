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
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Store, newId, nowIso } from './lib/store.mjs'
import { parseCron, nextCronAfter, cronOccurrences, parseInterval, CronParseError } from './lib/cron-next.mjs'

export const name = 'dsh-scheduler'
export const inject = ['webServer']

// schemastery `.default()` stores the argument AS-IS (a literal): a factory
// function would fail Cordis string validation and take down the whole web
// plugin tree. Following the harness convention (settings-file: "defaulting
// happens here, never inline"): string fields stay default-less in the schema
// and env-derived values are resolved at runtime in resolveConfig(); number
// fields may carry literal defaults (retry-policy precedent).
export const Config = Schema.object({
  /** Storage root for jobs.json / runs.jsonl / lock (optional; resolved at runtime). */
  dataDir: Schema.string(),
  /** Harness checkout root: dsh CLI entry + tsx live here (optional). */
  harnessDir: Schema.string(),
  /** Default workspace (cwd) for jobs that do not pin one (optional). */
  defaultWorkspace: Schema.string(),
  /** Per-run timeout before the headless process is killed. */
  timeoutMs: Schema.number().min(10_000).default(30 * 60_000),
  /** Max concurrent headless runs. */
  maxConcurrent: Schema.number().min(1).max(8).default(2),
  /** Periodic tick interval (drift/overdue catch-up). */
  tickMs: Schema.number().min(5_000).default(60_000),
}).description('dsh-scheduler: DSH 定时任务（cron/interval/once + headless 执行 + 台账）')

/** Resolve runtime config: explicit values win, env falls back, then defaults. */
function resolveConfig(config) {
  const dshHome = process.env.DSH_HOME ?? `${homedir()}/.dsh`
  return {
    dataDir: config.dataDir ?? `${dshHome}/storages/dsh-scheduler`,
    harnessDir: config.harnessDir ?? process.env.DSH_HARNESS_DIR ?? '/Users/echerlos/Downloads/projects/deepseek-harness',
    defaultWorkspace: config.defaultWorkspace ?? process.env.DSH_SCHEDULER_WORKSPACE ?? process.cwd(),
    timeoutMs: config.timeoutMs ?? 30 * 60_000,
    maxConcurrent: config.maxConcurrent ?? 2,
    tickMs: config.tickMs ?? 60_000,
  }
}

const MAX_TIMER_DELAY_MS = 2_147_483_647
const OUTPUT_TAIL_BYTES = 8192

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
  return { kind, expression, timezone, ...(everySeconds !== undefined ? { everySeconds } : {}) }
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

/** Validate a job payload (create/update), returns normalized job fields. */
function normalizeJob(input, existing) {
  if (!input || typeof input !== 'object') throw new Error('invalid job payload')
  const name = String(input.name ?? existing?.name ?? '').trim()
  const prompt = String(input.prompt ?? existing?.prompt ?? '').trim()
  if (name === '') throw new Error('name is required')
  if (prompt === '') throw new Error('prompt is required')
  const trigger = normalizeTrigger(input.trigger ?? existing?.trigger)
  const workspace = String(input.workspace ?? existing?.workspace ?? '').trim()
  const enabled = input.enabled !== undefined ? Boolean(input.enabled) : (existing?.enabled ?? true)
  return { name, prompt, trigger, workspace, enabled }
}

// ---- cordis plugin ----------------------------------------------------------

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const store = new Store(cfg.dataDir)
  const inflight = new Map() // jobId -> runId
  let tickTimer
  let wakeTimer
  let lastTickAt = null
  let stopping = false

  const defaultEntry = resolveCliEntry(cfg.harnessDir)

  function resolveCliEntry(harnessDir) {
    const bundled = join(harnessDir, 'apps/cli/lib/bin.js')
    if (existsSync(bundled)) return { args: [bundled], source: 'lib' }
    return {
      args: ['--import', join(harnessDir, 'node_modules/tsx/esm'), join(harnessDir, 'apps/cli/src/bin.ts')],
      source: 'tsx',
    }
  }

  // ---- executor -------------------------------------------------------------

  function runJob(job, triggerKind, scheduledFor) {
    if (inflight.has(job.id)) {
      store.appendRun({
        id: newId('run'), jobId: job.id, triggerKind, scheduledFor,
        status: 'skipped', startedAt: nowIso(), completedAt: nowIso(),
        error: 'already running',
      })
      return
    }
    if (inflight.size >= cfg.maxConcurrent) {
      store.appendRun({
        id: newId('run'), jobId: job.id, triggerKind, scheduledFor,
        status: 'skipped', startedAt: nowIso(), completedAt: nowIso(),
        error: `concurrency limit (${cfg.maxConcurrent}) reached`,
      })
      return
    }

    const runId = newId('run')
    const startedAt = nowIso()
    inflight.set(job.id, runId)
    const run = { id: runId, jobId: job.id, triggerKind, scheduledFor, status: 'running', startedAt }
    store.appendRun(run)

    const workspace = job.workspace || cfg.defaultWorkspace
    try { mkdirSync(workspace, { recursive: true }) } catch { /* spawn will fail with a clear error */ }
    const startedMs = Date.now()
    let output = ''
    let killed = false

    const child = spawn(process.execPath, [...defaultEntry.args, '--profile', 'headless', job.prompt], {
      cwd: workspace,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: cfg.timeoutMs,
    })
    child.stdout.on('data', (d) => { output = tail(output + d.toString('utf8')) })
    child.stderr.on('data', (d) => { output = tail(output + d.toString('utf8')) })
    child.on('error', (error) => {
      killed = true
      finish({ status: 'failed', error: `spawn: ${renderThrown(error)}` })
    })
    child.on('close', (code, signal) => {
      if (killed) return
      if (signal) {
        finish({ status: 'failed', error: `killed by ${signal}` })
      } else if (code === 0) {
        finish({ status: 'succeeded', exitCode: 0 })
      } else {
        finish({ status: 'failed', exitCode: code ?? -1 })
      }
    })

    function finish(result) {
      if (!inflight.has(job.id) || inflight.get(job.id) !== runId) return
      inflight.delete(job.id)
      const completedAt = nowIso()
      const finalRun = {
        ...run,
        ...result,
        durationMs: Date.now() - startedMs,
        outputHead: output,
        completedAt,
      }
      store.appendRun(finalRun)

      const live = store.getJob(job.id)
      if (live) {
        const succeeded = result.status === 'succeeded'
        const paused = live.state === 'paused' || live.enabled === false
        const next = paused ? (live.nextRunAt ? Date.parse(live.nextRunAt) : null) : computeNextRun(live, Date.now())
        store.upsertJob({
          ...live,
          lastRunAt: completedAt,
          lastStatus: result.status,
          runCount: (live.runCount ?? 0) + 1,
          consecutiveFailures: succeeded ? 0 : (live.consecutiveFailures ?? 0) + 1,
          nextRunAt: next ? new Date(next).toISOString() : null,
          state: next === null && live.trigger.kind === 'once' ? 'completed' : live.state,
          updatedAt: completedAt,
        })
      }
      scheduleWake()
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
        if (job.nextRunAt && Date.parse(job.nextRunAt) <= now) {
          runJob(job, 'scheduled', job.nextRunAt)
        }
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
    if (earliest === null) return
    const delay = Math.min(Math.max(earliest - now, 500), MAX_TIMER_DELAY_MS)
    wakeTimer = setTimeout(() => tick(), delay)
  }

  function start() {
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
      cliEntry: defaultEntry.source,
      maxConcurrent: cfg.maxConcurrent,
      timeoutMs: cfg.timeoutMs,
      tickMs: cfg.tickMs,
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

  const server = ctx.webServer.register({
    kind: 'prefix',
    path: '/scheduler',
    handler: async (req, r) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const method = req.method ?? 'GET'
      const parts = url.pathname.split('/').filter(Boolean) // [scheduler, jobs?, id?, action?]
      try {
        if (method === 'GET' && (url.pathname === '/scheduler' || url.pathname === '/scheduler/status')) return routeStatus(r)
        if (method === 'GET' && url.pathname === '/scheduler/jobs') return routeListJobs(r)
        if (method === 'GET' && url.pathname === '/scheduler/preview') return routePreview(r, url)
        if (method === 'POST' && url.pathname === '/scheduler/jobs') return routeCreateJob(r, req)
        if (parts.length >= 3 && parts[0] === 'scheduler' && parts[1] === 'jobs') {
          const id = parts[2]
          const action = parts[3]
          if (!action && method === 'GET') return routeGetJob(r, id)
          if (!action && method === 'PATCH') return routeUpdateJob(r, id, req)
          if (!action && method === 'DELETE') return routeDeleteJob(r, id)
          if (action === 'trigger' && method === 'POST') return routeTriggerJob(r, id)
          if (action === 'pause' && method === 'POST') return routePauseJob(r, id)
          if (action === 'resume' && method === 'POST') return routeResumeJob(r, id)
          if (action === 'runs' && method === 'GET') return routeJobRuns(r, id, url)
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
      // Let in-flight headless children exit naturally; the web drain owns the
      // process boundary.
    }
  }, 'dsh-scheduler.lifecycle()')
}
