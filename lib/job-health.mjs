/**
 * 作业健康的两轴折叠（纯函数，无 IO）。
 *
 * 为什么要把「调度」与「故障」分成两根轴（2026-11-18 落地）：
 *
 * `/plugins/dsh-scheduler/status` 原先只有 `failing = consecutiveFailures > 0` 一个数，
 * 于是**被自动熔断停掉的作业与正在失败的作业混在同一个数字里**。实测那天的形状是
 * `failing=3`，其中 2 个的 `pausedReason` 是 `max_consecutive_failures` ——
 * 它们已经不再运行，却与真正在失败的作业一起报红，同时**没有区分"红灯之后有人/系统
 * 把它关掉了，而故障并没有解决"**。两个后果：
 *
 *   1. 只看 `failing` 的人无法判断"这条线现在还在烧钱吗"；
 *   2. 想消红的人可以顺手把作业 pause 掉，红就消失、故障还在 —— 而摘要说不出来。
 *
 * 所以这里把同一个作业拆成两个正交的读数：
 *
 *   schedulerState : enabled | paused | completed      —— 它现在跑不跑
 *   faultState     : ok | active-failing
 *                    | auto-paused-failing            —— 被熔断停掉，故障未解决
 *                    | manual-paused-unresolved        —— 人工停掉，故障未解决
 *
 * 不变式（回归锁在这几条上）：
 *   - **暂停不能清除故障**：只要 consecutiveFailures > 0，faultState 就不是 ok；
 *   - **自动熔断不能等同于已接受风险**：auto-paused-failing 必须单独可数；
 *   - `failing` 保留为三个失败态之和（向后兼容旧消费方），但不再是唯一读数。
 */

/** 调度轴：作业现在跑不跑。 */
export const SCHEDULER_STATES = Object.freeze(['enabled', 'paused', 'completed'])

/** 故障轴：失败有没有被解决（与"跑不跑"无关）。 */
export const FAULT_STATES = Object.freeze([
  'ok',
  'active-failing',
  'auto-paused-failing',
  'manual-paused-unresolved',
])

/** 熔断器写入的 reason；只有它代表"系统自己停的"。 */
export const AUTO_PAUSE_REASON = 'max_consecutive_failures'

/** @param {Record<string, unknown>} job */
export function schedulerStateOf(job) {
  if (job?.state === 'completed') return 'completed'
  if (job?.enabled === false || job?.state === 'paused') return 'paused'
  return 'enabled'
}

/** @param {Record<string, unknown>} job */
export function faultStateOf(job) {
  const failures = Number(job?.consecutiveFailures ?? 0)
  if (!Number.isFinite(failures) || failures <= 0) return 'ok'
  if (schedulerStateOf(job) === 'enabled') return 'active-failing'
  return job?.pausedReason === AUTO_PAUSE_REASON ? 'auto-paused-failing' : 'manual-paused-unresolved'
}

/**
 * 一次折叠出两个轴 + 供 `/status` 用的计数。
 *
 * 计数口径：
 *   - `enabled` / `paused` / `completed`  ：调度轴，三者之和 = jobs（**互斥且完备**）
 *   - `failing`                           ：三个失败态之和（向后兼容的旧读数）
 *   - `failingActive`                     ：正在跑且失败
 *   - `failingPausedUnresolved`           ：已停用但故障未解决（= auto + manual）
 *   - `autoPausedFailing` / `manualPausedUnresolved`：按"谁停的"再分一刀
 *
 * 为什么要保留 `failing`：它的消费方（告警阈值、日报文案）读的是这个字段名。
 * 保留它并让它**等于新三态之和**，比改字段名更能保证"没人因为改名而看不见"。
 */
export function countsOf(jobs) {
  const list = Array.isArray(jobs) ? jobs : []
  const out = {
    jobs: list.length,
    enabled: 0,
    paused: 0,
    completed: 0,
    failing: 0,
    failingActive: 0,
    failingPausedUnresolved: 0,
    autoPausedFailing: 0,
    manualPausedUnresolved: 0,
  }
  for (const job of list) {
    const s = schedulerStateOf(job)
    out[s] += 1
    switch (faultStateOf(job)) {
      case 'active-failing':
        out.failingActive += 1
        break
      case 'auto-paused-failing':
        out.autoPausedFailing += 1
        break
      case 'manual-paused-unresolved':
        out.manualPausedUnresolved += 1
        break
      default:
        break
    }
  }
  out.failing = out.failingActive + out.autoPausedFailing + out.manualPausedUnresolved
  out.failingPausedUnresolved = out.autoPausedFailing + out.manualPausedUnresolved
  return out
}

/** `/status` 的 detail.jobs[] 需要的那两行（其余字段仍由调用方给）。 */
export function healthOf(job) {
  return { schedulerState: schedulerStateOf(job), faultState: faultStateOf(job) }
}
