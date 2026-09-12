/**
 * store.mjs — durable file store for dsh-scheduler.
 *
 * Layout (under dataDir, default ~/.dsh/storages/dsh-scheduler):
 *   jobs.json     — task definitions, atomic write (tmp + rename)
 *   runs.jsonl    — append-only run ledger; past the size cap it rotates by
 *                   keeping the newest `maxRuns` lines and archiving older
 *                   ones into archive/runs-<YYYY-MM>.jsonl (nothing is dropped)
 *   archive/      — rotated ledger segments (audit/backfill source)
 *   .tick.lock    — mkdir-based single-instance lock (prevents double fire
 *                   across overlapping web restarts); stale locks recovered
 *                   by mtime timeout
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LOCK_STALE_MS = 5 * 60_000
const DEFAULT_ROTATE_BYTES = 2 * 1024 * 1024

export class Store {
  constructor(dataDir, { maxRuns = 5000, inflightProvider, rotateBytes = DEFAULT_ROTATE_BYTES } = {}) {
    this.dir = dataDir
    this.jobsPath = join(dataDir, 'jobs.json')
    this.runsPath = join(dataDir, 'runs.jsonl')
    this.lockPath = join(dataDir, '.tick.lock')
    this.archiveDir = join(dataDir, 'archive')
    this.maxRuns = maxRuns
    this.rotateBytes = rotateBytes
    // Optional provider of currently in-flight run ids: the derived run view
    // keeps those as `running` (they are genuinely live) and only synthesizes
    // `interrupted` for start-only runs that are NOT in flight (host died).
    this.inflightProvider = inflightProvider
    mkdirSync(dataDir, { recursive: true })
  }

  // ---- jobs ----

  loadJobs() {
    try {
      const raw = readFileSync(this.jobsPath, 'utf8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  saveJobs(jobs) {
    const tmp = `${this.jobsPath}.tmp`
    writeFileSync(tmp, JSON.stringify(jobs, null, 2) + '\n', 'utf8')
    renameSync(tmp, this.jobsPath)
  }

  getJob(id) {
    return this.loadJobs().find((j) => j.id === id) ?? null
  }

  upsertJob(job) {
    const jobs = this.loadJobs()
    const index = jobs.findIndex((j) => j.id === job.id)
    if (index === -1) jobs.push(job)
    else jobs[index] = job
    this.saveJobs(jobs)
    return job
  }

  deleteJob(id) {
    const jobs = this.loadJobs()
    const next = jobs.filter((j) => j.id !== id)
    if (next.length === jobs.length) return false
    this.saveJobs(next)
    return true
  }

  // ---- runs (append-only event ledger) ----
  //
  // Event-sourcing shape (mirrors DSH session logs): the ledger is
  // append-only and never mutated; a run's lifecycle is written as events
  // tagged `evt`:
  //   { evt: 'start',   status: 'running' }   — fired (dispatch)
  //   { evt: 'finish',  status: 'succeeded'|'failed' } — settled (final run object)
  //   { evt: 'skipped', status: 'skipped' }   — skipped (already-running /
  //                                            concurrency / catch-up drop)
  // listRuns() folds events per runId into a derived view. A run whose only
  // event is `start` means the host died before finish() persisted the final
  // event — the derived view synthesizes `interrupted` (the ledger itself is
  // untouched, exactly like DSH repair semantics).

  appendRun(run) {
    const line = JSON.stringify(run) + '\n'
    try {
      appendFileSync(this.runsPath, line, 'utf8')
    } catch {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(this.runsPath, line, 'utf8')
    }
    // Rotate the ledger when it exceeds the size cap: the newest `maxRuns`
    // lines stay in runs.jsonl, older lines are APPENDED to monthly archive
    // files (never dropped) — the 2026-09-12 audit showed a dropping trim
    // would have left only ~41 days of history.
    let size = 0
    try { size = statSync(this.runsPath).size } catch { return }
    if (size > this.rotateBytes) this.rotateRuns()
  }

  /** Fold the event ledger into a per-run derived view (newest first). */
  listRuns(jobId, limit = 50, inflightRunIds) {
    let lines = []
    try {
      lines = readFileSync(this.runsPath, 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
    const events = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const filtered = jobId ? events.filter((r) => r.jobId === jobId) : events
    // Fold: the last-written event for a runId is its current state.
    const last = new Map()
    for (const ev of filtered) last.set(ev.id, ev)
    const inflight = inflightRunIds ?? (this.inflightProvider ? this.inflightProvider() : new Set())
    const derived = [...last.values()].map((run) => {
      if (run.status === 'running' && !inflight.has(run.id)) {
        // No finish event yet and the run is not in flight → the host died
        // mid-run. Synthesize interrupted so the ledger never shows a
        // permanently "running" ghost run.
        return {
          ...run,
          status: 'interrupted',
          completedAt: run.completedAt ?? run.startedAt,
          error: (run.error ? `${run.error}; ` : '') + 'host restarted before run settled',
        }
      }
      return run
    })
    return derived.slice(-limit).reverse()
  }

  /**
   * Rotate the ledger: keep the newest `maxRuns` lines inline, move the rest
   * into per-month archive files under archive/. Returns { archived, kept }.
   * Best-effort: a failure (disk full, race) leaves the ledger untouched.
   */
  rotateRuns() {
    try {
      const lines = readFileSync(this.runsPath, 'utf8').split('\n').filter(Boolean)
      if (lines.length <= this.maxRuns) return { archived: 0, kept: lines.length }
      const drop = lines.slice(0, lines.length - this.maxRuns)
      const keep = lines.slice(-this.maxRuns)
      const groups = new Map()
      for (const line of drop) {
        let month = 'unknown'
        try {
          const o = JSON.parse(line)
          const t = o.startedAt ?? o.scheduledFor ?? o.completedAt
          if (t && Number.isFinite(Date.parse(t))) month = String(t).slice(0, 7)
        } catch { /* keep the raw line in 'unknown' */ }
        if (!groups.has(month)) groups.set(month, [])
        groups.get(month).push(line)
      }
      mkdirSync(this.archiveDir, { recursive: true })
      for (const [month, group] of groups) {
        appendFileSync(join(this.archiveDir, `runs-${month}.jsonl`), group.join('\n') + '\n', 'utf8')
      }
      const tmp = `${this.runsPath}.tmp`
      writeFileSync(tmp, keep.join('\n') + '\n', 'utf8')
      renameSync(tmp, this.runsPath)
      return { archived: drop.length, kept: keep.length }
    } catch {
      return { archived: 0, kept: 0 } // ledger is best-effort
    }
  }

  /** Read archived ledger lines (for audit/backfill); month e.g. '2026-09'. */
  readArchive(month) {
    try {
      return readFileSync(join(this.archiveDir, `runs-${month}.jsonl`), 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  // ---- single-instance lock ----

  /** Acquire the tick lock; returns true on success. */
  acquireLock() {
    try {
      mkdirSync(this.lockPath)
      writeFileSync(join(this.lockPath, 'owner'), `${process.pid} ${new Date().toISOString()}`, 'utf8')
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') return false
      // Recover stale locks (crash left behind).
      try {
        const st = statSync(this.lockPath)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          rmSync(this.lockPath, { recursive: true, force: true })
          return this.acquireLock()
        }
      } catch { /* raced removal */ }
      return false
    }
  }

  releaseLock() {
    try { rmSync(this.lockPath, { recursive: true, force: true }) } catch { /* noop */ }
  }
}

/** Stable id helpers. */
export function newId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 12)}`
}

/** Current UTC ISO instant. */
export function nowIso() {
  return new Date().toISOString()
}
