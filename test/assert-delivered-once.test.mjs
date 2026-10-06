// assert-delivered-once 的夹具测试（2026-10-06）。
// 判据必须双向：恰好一次通过 / 缺失与重复都必须红 / 归档也要扫 / 读不到台账 fail-closed。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { countDeliveries, judge } from '../scripts/assert-delivered-once.mjs'

const script = pathToFileURL(new URL('../scripts/assert-delivered-once.mjs', import.meta.url).pathname).pathname

function ledger(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

const KEY = 'job-x|2026-10-06T00:30:00.000Z'
const ev = (status, extra = {}) => ({
  id: 'run-1', jobId: 'job-x', evt: 'delivered',
  deliveryKey: KEY, deliveryStatus: status, channel: 'feishu',
  startedAt: '2026-10-06T00:30:01.000Z', completedAt: '2026-10-06T00:31:00.000Z', ...extra,
})

test('countDeliveries: 只数 delivered 事件且按 key 过滤', () => {
  const text = ledger([
    { id: 'r1', jobId: 'job-x', evt: 'start', status: 'running' },
    ev('delivered'),
    { id: 'r2', jobId: 'job-y', evt: 'delivered', deliveryKey: 'other|1', deliveryStatus: 'delivered' },
    { id: 'r1', jobId: 'job-x', evt: 'finish', status: 'succeeded' },
  ])
  const hits = countDeliveries(text, KEY)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].status, 'delivered')
  assert.equal(countDeliveries(text, 'missing|key').length, 0)
})

test('judge: 恰好一条通过；缺失红；重复红（含两条明细）', () => {
  assert.equal(judge([ev('delivered')]).ok, true)
  assert.equal(judge([ev('skipped')]).ok, true, '有意静默（--skip）也算合法交付')
  const missing = judge([])
  assert.equal(missing.ok, false)
  assert.equal(missing.verdict, 'missing')
  assert.equal(judge([], { allowMissing: true }).ok, true)
  const dup = judge([ev('delivered'), ev('delivered', { id: 'run-2' })])
  assert.equal(dup.ok, false)
  assert.equal(dup.verdict, 'duplicate')
  assert.equal(dup.hits.length, 2)
})

test('CLI: 恰好一次 exit 0；缺失 exit 1；重复 exit 1；--allow-missing 放行缺失', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'assert-delivered-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const runs = join(dir, 'runs.jsonl')
  const run = (args) => {
    try {
      const out = execFileSync(process.execPath, [script, runs, KEY, ...args], { encoding: 'utf8' })
      return { code: 0, out }
    } catch (error) {
      return { code: error.status, out: String(error.stdout ?? '') }
    }
  }

  writeFileSync(runs, ledger([ev('delivered')]))
  assert.equal(run([]).code, 0)
  assert.match(run([]).out, /PASS/)

  writeFileSync(runs, ledger([{ id: 'r', jobId: 'job-x', evt: 'finish', status: 'succeeded' }]))
  assert.equal(run([]).code, 1, '缺失必须红')
  assert.match(run(['--json']).out, /"verdict": "missing"/)
  assert.equal(run(['--allow-missing']).code, 0)

  writeFileSync(runs, ledger([ev('delivered'), ev('delivered', { id: 'run-2' })]))
  assert.equal(run([]).code, 1, '重复必须红')
  assert.match(run(['--json']).out, /"verdict": "duplicate"/)
})

test('归档也要扫：轮转后的 delivered 不得被读成 missing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'assert-delivered-archive-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'archive'), { recursive: true })
  writeFileSync(join(dir, 'archive', 'runs-2026-10.jsonl'), ledger([ev('delivered')]))
  writeFileSync(join(dir, 'runs.jsonl'), ledger([{ id: 'r', jobId: 'job-x', evt: 'finish', status: 'succeeded' }]))
  const out = execFileSync(process.execPath, [script, join(dir, 'runs.jsonl'), KEY, '--json'], { encoding: 'utf8' })
  assert.match(out, /"ok": true/)
})

test('fail-closed：台账一个文件都读不到 → exit 2（不是"没有交付"）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'assert-delivered-nofile-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  try {
    execFileSync(process.execPath, [script, join(dir, 'runs.jsonl'), KEY], { encoding: 'utf8' })
    assert.fail('应当非零退出')
  } catch (error) {
    assert.equal(error.status, 2)
    assert.match(String(error.stderr ?? ''), /ledger_unreadable/)
  }
})
