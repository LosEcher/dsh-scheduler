import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AUTO_PAUSE_REASON,
  countsOf,
  faultStateOf,
  healthOf,
  schedulerStateOf,
} from '../lib/job-health.mjs'

const job = (over) => ({ id: 'j', enabled: true, state: 'scheduled', consecutiveFailures: 0, ...over })

// ── 四条正向形态（对应 /status 上真实存在的四个作业） ──────────────────────

test('enabled + 失败 => active-failing（正在烧钱的那一档）', () => {
  const j = job({ enabled: true, state: 'scheduled', consecutiveFailures: 2 })
  assert.equal(schedulerStateOf(j), 'enabled')
  assert.equal(faultStateOf(j), 'active-failing')
  const c = countsOf([j])
  assert.equal(c.failingActive, 1)
  assert.equal(c.failingPausedUnresolved, 0)
  assert.equal(c.failing, 1)
})

test('熔断停用 + 失败 => auto-paused-failing 且 unresolved=1（暂停不清除故障）', () => {
  const j = job({
    enabled: false,
    state: 'paused',
    pausedReason: AUTO_PAUSE_REASON,
    consecutiveFailures: 5,
  })
  assert.equal(schedulerStateOf(j), 'paused')
  assert.equal(faultStateOf(j), 'auto-paused-failing')
  const c = countsOf([j])
  assert.equal(c.autoPausedFailing, 1, '自动熔断必须单独可数（否则等于被摘要吞掉）')
  assert.equal(c.failingPausedUnresolved, 1)
  assert.equal(c.failing, 1, '暂停不能让 failing 归零')
  assert.equal(c.failingActive, 0)
})

test('人工暂停 + 失败 => manual-paused-unresolved（人工停掉 ≠ 已接受风险）', () => {
  const j = job({ enabled: false, state: 'paused', pausedReason: 'manual-20261118', consecutiveFailures: 1 })
  assert.equal(faultStateOf(j), 'manual-paused-unresolved')
  assert.equal(countsOf([j]).manualPausedUnresolved, 1)
})

test('已迁移/上次成功 => paused 且 faultState=ok、unresolved=0（不能把"没在跑"当故障）', () => {
  const j = job({ enabled: false, state: 'paused', consecutiveFailures: 0, lastStatus: 'succeeded' })
  assert.equal(schedulerStateOf(j), 'paused')
  assert.equal(faultStateOf(j), 'ok')
  const c = countsOf([j])
  assert.equal(c.paused, 1)
  assert.equal(c.failingPausedUnresolved, 0)
  assert.equal(c.failing, 0)
})

// ── 不变式 ────────────────────────────────────────────────────────────────

test('调度轴互斥且完备：enabled+paused+completed 恒等于 jobs', () => {
  const jobs = [
    job({ id: 'a' }),
    job({ id: 'b', enabled: false, state: 'paused', consecutiveFailures: 5, pausedReason: AUTO_PAUSE_REASON }),
    job({ id: 'c', state: 'completed' }),
    job({ id: 'd', enabled: false, state: 'paused' }),
  ]
  const c = countsOf(jobs)
  assert.equal(c.enabled + c.paused + c.completed, c.jobs)
  assert.equal(c.jobs, 4)
})

test('failing 恒等于三个失败态之和（向后兼容的旧读数不得偏离新分档）', () => {
  const jobs = [
    job({ id: 'a', consecutiveFailures: 1 }),
    job({ id: 'b', enabled: false, state: 'paused', consecutiveFailures: 5, pausedReason: AUTO_PAUSE_REASON }),
    job({ id: 'c', enabled: false, state: 'paused', consecutiveFailures: 2 }),
    job({ id: 'd' }),
  ]
  const c = countsOf(jobs)
  assert.equal(c.failing, c.failingActive + c.autoPausedFailing + c.manualPausedUnresolved)
  assert.equal(c.failing, 3)
  assert.equal(c.failingPausedUnresolved, c.autoPausedFailing + c.manualPausedUnresolved)
})

test('缺字段/脏值不得被读成"失败"（consecutiveFailures 缺失或非数 => ok）', () => {
  assert.equal(faultStateOf({ id: 'x', enabled: true }), 'ok')
  assert.equal(faultStateOf({ id: 'y', enabled: true, consecutiveFailures: 'oops' }), 'ok')
  assert.equal(faultStateOf(null), 'ok')
})

test('healthOf 两行同时给出，且与单轴函数一致', () => {
  const j = job({ enabled: false, state: 'paused', pausedReason: AUTO_PAUSE_REASON, consecutiveFailures: 3 })
  const h = healthOf(j)
  assert.deepEqual(h, { schedulerState: 'paused', faultState: 'auto-paused-failing' })
})

test('空输入不虚构计数（否则"没有作业"会被读成"没有失败"）', () => {
  const c = countsOf([])
  assert.equal(c.jobs, 0)
  assert.equal(c.failing, 0)
  assert.equal(countsOf(undefined).jobs, 0)
})
