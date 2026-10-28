// maxRunsPerDay（确定性计数闸门）的判据测试。
//
// 为什么这个闸门要单独测：它是**唯一**会在作业真的该跑时主动不跑的机制。判错方向
// 的代价不对称——
//   · 少拦（计数漏了 skip/重试/昨天）⇒ 跑飞保护失效，退化成"没这功能"；
//   · 多拦（把重试或 skip 也算进额度、日界算错）⇒ 正常作业被自己挤掉，一整天不干活。
// 所以每条"该拦"的用例都配一条"不该拦"的负向控制。
//
// 依据（为什么要做它）：2026-08-18 的 fire→crash→restart→refire 循环把同一个过期
// occurrence 触发了 10+ 次。那次的根因（dispatch 时先推进 nextRunAt）已修、deliveryKey
// 幂等也已兜底，但两者都在防"同一事件重复"，防不住"一天被触发 20 次不同 occurrence"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

// 必须带 --preserve-symlinks 跑（见 package.json 的 test script）：index.mjs 依赖
// @deepseek-ai/schemastery，只有走 profile 的 node_modules 才解析得到。
const mod = await import(pathToFileURL(
  `${process.env.HOME}/.dsh/profiles/web/node_modules/dsh-scheduler/index.mjs`,
).href)

const { dayKeyInZone, runsToday, runCapDecision, normalizeJob, applyExplicitClears, EXPLICIT_CLEAR_KEYS } = mod

// 边界时刻：北京时间 2026-10-28 01:00 = UTC 2026-10-27 17:00 ⇒ 东八区与 UTC 不同日。
const BOUNDARY = Date.parse('2026-10-28T01:00:00+08:00')
const run = (startedAt, extra = {}) => ({ attempt: 1, status: 'succeeded', startedAt, ...extra })

test('dayKeyInZone：同一时刻在不同时区是不同的日历日', () => {
  assert.equal(dayKeyInZone(BOUNDARY, 'Asia/Shanghai'), '2026-10-28')
  assert.equal(dayKeyInZone(BOUNDARY, 'UTC'), '2026-10-27')
  // 未指定 / 'local' ⇒ 宿主本地时区（本机为 Asia/Shanghai，但断言只要求"是 28 日"，
  // 免得把测试绑死在构建机的时区上 —— 真绑定会让 CI 在 UTC runner 上红得没有意义）。
  assert.equal(dayKeyInZone(BOUNDARY), dayKeyInZone(BOUNDARY, 'local'))
})

test('dayKeyInZone：非法时区名回退而不抛（job.trigger.timezone 是自由文本）', () => {
  // 拼错时区不该让计数闸门变成"每次 fire 都崩"的故障源。
  assert.doesNotThrow(() => dayKeyInZone(BOUNDARY, 'Not/AZone'))
  assert.equal(dayKeyInZone(BOUNDARY, 'Not/AZone'), dayKeyInZone(BOUNDARY))
})

test('runsToday：只数当天、attempt=1、真的起了子进程的 run', () => {
  const now = Date.parse('2026-10-28T10:00:00+08:00')
  const runs = [
    run('2026-10-28T09:00:00+08:00'),
    run('2026-10-28T08:00:00+08:00', { status: 'failed' }),
    run('2026-10-28T07:00:00+08:00', { status: 'interrupted' }), // 宿主崩溃遗留，确实起过子进程
    run('2026-10-27T09:00:00+08:00'),                            // 昨天
    run('2026-10-28T06:00:00+08:00', { status: 'skipped' }),      // 没起子进程
    run('2026-10-28T05:00:00+08:00', { attempt: 2 }),             // 重试
  ]
  assert.equal(runsToday(runs, 'Asia/Shanghai', now), 3)
})

test('NEGATIVE：skipped 不消耗额度（否则配错的作业把自己一整天挤掉）', () => {
  const now = Date.parse('2026-10-28T10:00:00+08:00')
  const allSkipped = [
    run('2026-10-28T09:00:00+08:00', { status: 'skipped' }),
    run('2026-10-28T08:30:00+08:00', { status: 'skipped' }),
  ]
  assert.equal(runsToday(allSkipped, 'Asia/Shanghai', now), 0)
  const decision = runCapDecision({ maxRunsPerDay: 1 }, allSkipped, now)
  assert.equal(decision.skip, false, 'skip 不该让 cap=1 的作业今天就跑不了')
  assert.equal(decision.used, 0)
})

test('NEGATIVE：重试不消耗额度（重试已由 maxAttempts 界定，是有限的）', () => {
  const now = Date.parse('2026-10-28T10:00:00+08:00')
  const retries = [
    run('2026-10-28T09:00:00+08:00'),
    run('2026-10-28T09:05:00+08:00', { attempt: 2 }),
    run('2026-10-28T09:10:00+08:00', { attempt: 3 }),
  ]
  // 一次触发 + 两次重试 = 只消耗 1 个额度 ⇒ cap=1 之后才该拦。
  assert.equal(runsToday(retries, 'Asia/Shanghai', now), 1)
  assert.equal(runCapDecision({ maxRunsPerDay: 1 }, retries, now).skip, true)
})

test('runCapDecision：未配置/非法配置一律不拦（保护是 opt-in）', () => {
  const now = Date.parse('2026-10-28T10:00:00+08:00')
  const busy = [run('2026-10-28T09:00:00+08:00'), run('2026-10-28T08:00:00+08:00')]
  for (const job of [{}, { maxRunsPerDay: undefined }, { maxRunsPerDay: null }, { maxRunsPerDay: 0 }, { maxRunsPerDay: 'lots' }]) {
    const d = runCapDecision(job, busy, now)
    assert.equal(d.skip, false, `job=${JSON.stringify(job)} 不该拦住作业`)
  }
})

test('runCapDecision：used >= cap 才拦，而且是 >= 不是 >', () => {
  const now = Date.parse('2026-10-28T10:00:00+08:00')
  const j = (cap) => ({ maxRunsPerDay: cap, trigger: { timezone: 'Asia/Shanghai' } })
  assert.deepEqual(runCapDecision(j(1), [], now), { skip: false, used: 0, cap: 1 })
  assert.deepEqual(runCapDecision(j(1), [run('2026-10-28T09:00:00+08:00')], now), { skip: true, used: 1, cap: 1 })
  assert.deepEqual(runCapDecision(j(2), [run('2026-10-28T09:00:00+08:00')], now), { skip: false, used: 1, cap: 2 })
  const two = [run('2026-10-28T09:00:00+08:00'), run('2026-10-28T08:00:00+08:00')]
  assert.equal(runCapDecision(j(2), two, now).skip, true)
})

test('日界按作业自己的时区算，不按宿主时区', () => {
  // BOUNDARY = 北京时间 2026-10-28 01:00 = UTC 2026-10-27 17:00。
  // 一条 UTC 2026-10-27 10:00 的 run（= 北京 10-27 18:00）在两种口径下都属"昨天之前的
  // 那一天"？不是——它正是这个测试要展示的分歧点：
  //   · UTC 口径：run 与 now 同为 10-27 ⇒ 算"今天"，占额度；
  //   · 北京口径：run 是 10-27、now 是 10-28 ⇒ 算"昨天"，不占额度。
  const runs = [run('2026-10-27T10:00:00Z')]
  assert.equal(runsToday(runs, 'UTC', BOUNDARY), 1, 'UTC 作业：这条 run 属于它的今天')
  assert.equal(runsToday(runs, 'Asia/Shanghai', BOUNDARY), 0, '东八区作业：这条 run 属于它的昨天')
  // ⇒ 同一份台账，两种时区的作业得到不同额度占用；这正是"按作业时区"而不是
  //   按宿主时区计数的意义（否则跨时区混排时额度会被别人的日界切错）。
  assert.equal(runCapDecision({ maxRunsPerDay: 1, trigger: { timezone: 'UTC' } }, runs, BOUNDARY).skip, true)
  assert.equal(runCapDecision({ maxRunsPerDay: 1, trigger: { timezone: 'Asia/Shanghai' } }, runs, BOUNDARY).skip, false)
})

test('时间戳坏掉的 run 不计入（不猜、也不因此崩）', () => {
  const now = Date.parse('2026-10-28T10:00:00+08:00')
  assert.equal(runsToday([{ attempt: 1, status: 'succeeded', startedAt: 'not-a-date' }], 'Asia/Shanghai', now), 0)
  assert.equal(runsToday([{ attempt: 1, status: 'succeeded' }], 'Asia/Shanghai', now), 0)
})

test('normalizeJob：maxRunsPerDay 的钳位与清除语义', () => {
  const base = { name: 't', prompt: 'p', trigger: { kind: 'interval', expression: '1d' }, workspace: '/tmp' }
  assert.equal(normalizeJob({ ...base, maxRunsPerDay: 3 }).maxRunsPerDay, 3)
  assert.equal(normalizeJob({ ...base, maxRunsPerDay: 0 }).maxRunsPerDay, 1, '下限钳到 1')
  assert.equal(normalizeJob({ ...base, maxRunsPerDay: 1000 }).maxRunsPerDay, 96, '上限钳到 96')
  assert.equal(normalizeJob({ ...base, maxRunsPerDay: 2.5 }).maxRunsPerDay, undefined, '非整数不接受')
  // null 清除、undefined 保持（与 maxAttempts/timeoutMs 同一套语义）——
  // "保持"指的是**沿用 existing 的值**，不是把键丢掉：丢掉会让一次 PATCH
  // （只改 prompt）静默把保护关掉。
  const existing = normalizeJob({ ...base, maxRunsPerDay: 4 })
  assert.equal(normalizeJob({ ...base }, existing).maxRunsPerDay, 4, 'undefined ⇒ 沿用 existing')
  assert.equal(normalizeJob({ ...base, maxRunsPerDay: null }, existing).maxRunsPerDay, undefined, 'null ⇒ 清除')
  // 全新作业且未声明 ⇒ 结果里**没有这个键**（不是 0/undefined 占位）。
  assert.equal('maxRunsPerDay' in normalizeJob({ ...base }), false)
})

// ── PATCH 的 null 回滚必须真的清掉 ────────────────────────────────────────────
// 背景（2026-10-28 实测的静默失效）：`normalizeJob` 把 null 解释成"清空"时**不把
// 该键放进返回值**，而 routeUpdateJob 用 `{...existing, ...fields}` 合成 ⇒ 旧值复活。
// 于是"文档里写的回滚 `PATCH {"maxRunsPerDay": null}`"返回 200 但值还在 —— 一个
// HTTP 层看不出来的空操作。这里用纯函数把那条合成逻辑钉住（routeUpdateJob 是闭包
// 内函数，HTTP 层另有 host-smoke 覆盖）。
const patchJob = (existing, body) => {
  const fields = normalizeJob({ ...existing, ...body }, existing)
  return applyExplicitClears({ ...existing, ...fields }, body, fields)
}

test('PATCH null 真清除：maxRunsPerDay 回滚不是空操作', () => {
  const job = { name: 't', prompt: 'p', trigger: { kind: 'interval', expression: '1d' }, workspace: '/tmp', enabled: true, maxRunsPerDay: 6 }
  const cleared = patchJob(job, { maxRunsPerDay: null })
  assert.equal('maxRunsPerDay' in cleared, false, 'null 必须让键消失（否则回滚无效）')
  // 负向控制：同一个 job 只改 prompt（body 里没有这个键）⇒ 保护必须还在，
  // 否则一次无关的 PATCH 就能把跑飞保护静默关掉。
  assert.equal(patchJob(job, { prompt: 'p2' }).maxRunsPerDay, 6, 'undefined ⇒ 沿用，不得清除')
  // 负向控制：改成别的值也要保留（白名单只对 null 生效）。
  assert.equal(patchJob(job, { maxRunsPerDay: 3 }).maxRunsPerDay, 3)
})

test('白名单必须覆盖 normalizeJob 的每个 null 清除分支（漏一个 = 那个字段回滚失效）', () => {
  // 判据反向生成：把 maxRunsPerDay 换成别的字段名时，若 normalizeJob 有 null 分支
  // 而白名单没有它，这条就会红。当前名单是静态的，但断言"名单里的每个键都真的能被
  // null 清除"能防住"加进名单却没实现清除"的反向错误。
  const job = {
    name: 't', prompt: 'p', trigger: { kind: 'interval', expression: '1d' }, workspace: '/tmp', enabled: true,
    ...Object.fromEntries(EXPLICIT_CLEAR_KEYS.filter((k) => k !== 'model' && k !== 'notify').map((k) => [k, k === 'maxAttempts' || k === 'maxRunsPerDay' || k === 'retryDelayMs' || k === 'timeoutMs' ? 5 : 'x'])),
    model: { provider: 'a', model: 'b' },
    notify: { channel: 'feishu' },
  }
  for (const key of EXPLICIT_CLEAR_KEYS) {
    const cleared = patchJob(job, { [key]: null })
    assert.equal(key in cleared, false, `PATCH {${key}: null} 必须清掉该键`)
  }
})
