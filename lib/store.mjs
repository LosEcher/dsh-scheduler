/**
 * store.mjs — durable file store for dsh-scheduler.
 *
 * Layout (under dataDir, default ~/.dsh/storages/dsh-scheduler):
 *   jobs.json     — task definitions, atomic write (tmp + rename)
 *   runs.jsonl    — append-only run ledger, capped by maxRuns
 *   .tick.lock    — mkdir-based single-instance lock (prevents double fire
 *                   across overlapping web restarts); stale locks recovered
 *                   by mtime timeout
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LOCK_STALE_MS = 5 * 60_000

export class Store {
  constructor(dataDir, { maxRuns = 500 } = {}) {
    this.dir = dataDir
    this.jobsPath = join(dataDir, 'jobs.json')
    this.runsPath = join(dataDir, 'runs.jsonl')
    this.lockPath = join(dataDir, '.tick.lock')
    this.maxRuns = maxRuns
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

  // ---- runs (append-only ledger) ----

  appendRun(run) {
    const line = JSON.stringify(run) + '\n'
    try {
      appendFileSync(this.runsPath, line, 'utf8')
    } catch {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(this.runsPath, line, 'utf8')
    }
    // Trim ledger when it exceeds the cap (keep the newest tail).
    let size = 0
    try { size = statSync(this.runsPath).size } catch { return }
    if (size > 2 * 1024 * 1024) this.trimRuns()
  }

  listRuns(jobId, limit = 50) {
    let lines = []
    try {
      lines = readFileSync(this.runsPath, 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
    const runs = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const filtered = jobId ? runs.filter((r) => r.jobId === jobId) : runs
    return filtered.slice(-limit).reverse()
  }

  trimRuns() {
    try {
      const lines = readFileSync(this.runsPath, 'utf8').split('\n').filter(Boolean)
      const trimmed = lines.slice(-this.maxRuns)
      const tmp = `${this.runsPath}.tmp`
      writeFileSync(tmp, trimmed.join('\n') + (trimmed.length ? '\n' : ''), 'utf8')
      renameSync(tmp, this.runsPath)
    } catch { /* ledger is best-effort */ }
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
