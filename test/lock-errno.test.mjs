// tick 锁的 errno 三态（L2-4，2026-11-14）。
//
// 事故形状：`acquireLock()` 原来返回布尔，`mkdirSync` 抛什么都 `return false` ⇒ 调用方
// 一律当作"另一个实例在 tick"静默返回。于是**目录不可写（EACCES/EPERM）时调度器根本没在跑，
// 而外部看到的是 exit 0 + 无红**（与"拒写被读成 inFlight ⇒ dedup:true exit 0"同族）。
//
// 判据：只有 EEXIST 能当"忙"（正常抢占/陈旧锁恢复）；其它 errno 必须返回 denied，
// 让调用方**报错**（status 端点 lockProblem + error 日志）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store, classifyLockError } from '../lib/store.mjs'

test('classifyLockError：只有 EEXIST 是 busy，其它一律 denied 并带 code', () => {
  assert.deepEqual(classifyLockError({ code: 'EEXIST' }), { ok: false, reason: 'busy' })
  for (const code of ['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOSPC']) {
    const got = classifyLockError({ code })
    assert.equal(got.reason, 'denied', `${code} 不应被当成"忙"`)
    assert.equal(got.code, code)
  }
  assert.equal(classifyLockError(new Error('boom')).reason, 'denied')
  assert.equal(classifyLockError(undefined).code, 'unknown')
})

test('acquireLock：EEXIST ⇒ busy（不是 denied）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-busy-'))
  try {
    mkdirSync(join(dir, '.tick.lock'))           // 模拟另一个实例持有锁
    const store = new Store(dir)
    assert.deepEqual(store.acquireLock(), { ok: false, reason: 'busy' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('acquireLock：目录不可写 ⇒ denied（负向控制：不许静默当"忙"）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-denied-'))
  const dataDir = join(dir, 'data')
  mkdirSync(dataDir)
  try {
    chmodSync(dataDir, 0o500)                    // r-x：能在里面读，不能建目录
    const store = new Store(dataDir)             // 构造时已 mkdir（recursive 对已存在目录无操作）
    const got = store.acquireLock()
    assert.equal(got.ok, false)
    assert.equal(got.reason, 'denied', `期望 denied，实际 ${JSON.stringify(got)}`)
    assert.equal(typeof got.code, 'string')
  } finally {
    chmodSync(dataDir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('acquireLock：正常路径 ⇒ {ok:true}，且 releaseLock 后可再次获得', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-ok-'))
  try {
    const store = new Store(dir)
    assert.deepEqual(store.acquireLock(), { ok: true, reason: 'acquired' })
    assert.deepEqual(store.acquireLock(), { ok: false, reason: 'busy' }, '持锁期间第二次必须 busy')
    store.releaseLock()
    assert.deepEqual(store.acquireLock(), { ok: true, reason: 'acquired' })
    store.releaseLock()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
