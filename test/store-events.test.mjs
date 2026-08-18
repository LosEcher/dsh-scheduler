/**
 * store-events.test.mjs — run ledger event-sourcing derived view.
 *
 * The runs ledger is append-only; each run writes `start` (+ optional
 * `finish`/`skipped`) events. listRuns() folds per runId and synthesizes
 * `interrupted` for runs that only ever got a `start` event (host died
 * mid-run) — the ledger itself is never mutated.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, newId, nowIso } from '../lib/store.mjs'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scheduler-store-'))
  const store = new Store(dir)
  return { store, dir }
}

function startEvent(store, jobId, over = {}) {
  const id = newId('run')
  store.appendRun({ id, jobId, triggerKind: 'scheduled', scheduledFor: nowIso(), evt: 'start', status: 'running', startedAt: nowIso(), ...over })
  return id
}

function finishEvent(store, runId, jobId, status, over = {}) {
  store.appendRun({
    id: runId, jobId, evt: 'finish', status, startedAt: nowIso(), completedAt: nowIso(),
    durationMs: 100, ...over,
  })
}

test('start-only run → derived interrupted (host died mid-run)', (t) => {
  const { store, dir } = tempStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const jobId = 'job-1'
  const runId = startEvent(store, jobId)
  const runs = store.listRuns(jobId, 50)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].id, runId)
  assert.equal(runs[0].status, 'interrupted')
  assert.match(runs[0].error, /host restarted before run settled/)
  assert.ok(runs[0].completedAt)
})

test('start + finish → folded to one run with final status', (t) => {
  const { store, dir } = tempStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const jobId = 'job-1'
  const runId = startEvent(store, jobId)
  finishEvent(store, runId, jobId, 'succeeded', { outputHead: 'ok' })
  const runs = store.listRuns(jobId, 50)
  assert.equal(runs.length, 1, 'start+finish folds to a single run')
  assert.equal(runs[0].status, 'succeeded')
  assert.equal(runs[0].outputHead, 'ok')
  assert.equal(runs[0].evt, 'finish')
})

test('start + failed finish → failed, not interrupted', (t) => {
  const { store, dir } = tempStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const jobId = 'job-1'
  const runId = startEvent(store, jobId)
  finishEvent(store, runId, jobId, 'failed', { exitCode: 1 })
  const runs = store.listRuns(jobId, 50)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'failed')
  assert.equal(runs[0].exitCode, 1)
})

test('skipped event stays skipped (no interrupted synthesis)', (t) => {
  const { store, dir } = tempStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const jobId = 'job-1'
  store.appendRun({ id: newId('run'), jobId, evt: 'skipped', status: 'skipped', startedAt: nowIso(), completedAt: nowIso(), error: 'already running' })
  const runs = store.listRuns(jobId, 50)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'skipped')
})

test('in-flight run (id in inflightRunIds) stays running, not interrupted', (t) => {
  const { store, dir } = tempStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const jobId = 'job-1'
  const runId = startEvent(store, jobId)
  const inflight = new Set([runId])
  const runs = store.listRuns(jobId, 50, inflight)
  assert.equal(runs[0].status, 'running')
})

test('multiple runs per job: each folds independently, newest first', (t) => {
  const { store, dir } = tempStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const jobId = 'job-1'
  const r1 = startEvent(store, jobId, { startedAt: '2026-08-18T00:00:00.000Z' })
  finishEvent(store, r1, jobId, 'succeeded')
  const r2 = startEvent(store, jobId, { startedAt: '2026-08-18T01:00:00.000Z' }) // interrupted (no finish)
  const runs = store.listRuns(jobId, 50)
  assert.equal(runs.length, 2)
  assert.equal(runs[0].id, r2, 'newest first')
  assert.equal(runs[0].status, 'interrupted')
  assert.equal(runs[1].id, r1)
  assert.equal(runs[1].status, 'succeeded')
})

test('jobId filter isolates jobs', (t) => {
  const { store, dir } = tempStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = startEvent(store, 'job-a')
  finishEvent(store, a, 'job-a', 'succeeded')
  startEvent(store, 'job-b')
  assert.equal(store.listRuns('job-a', 50).length, 1)
  assert.equal(store.listRuns('job-b', 50).length, 1)
  assert.equal(store.listRuns(undefined, 50).length, 2)
})

test('limit slices the derived view', (t) => {
  const { store, dir } = tempStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const jobId = 'job-1'
  for (let i = 0; i < 5; i++) {
    const r = startEvent(store, jobId)
    finishEvent(store, r, jobId, 'succeeded')
  }
  const runs = store.listRuns(jobId, 2)
  assert.equal(runs.length, 2, 'limit applies after folding')
})

test('legacy rows without evt fold as-is (backward compatible)', (t) => {
  const { store, dir } = tempStore()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const jobId = 'job-1'
  // Pre-evt-sourcing row shape: a single complete run record.
  store.appendRun({ id: 'run-legacy', jobId, status: 'succeeded', startedAt: nowIso(), completedAt: nowIso() })
  const runs = store.listRuns(jobId, 50)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'succeeded')
  assert.equal(runs[0].id, 'run-legacy')
})
