/**
 * Locale bundle for the dsh-scheduler conversation tab.
 *
 * Dictionary namespace `scheduler`, declared into LocaleNamespaceMap so the
 * slot renderer synthesizes the typed `t` seat (PropsLocale) for the tab
 * component. Copy lives here only — the component and the slot registration
 * never hardcode strings.
 */

/** Locale keys this tab renders. */
export type SchedulerKey =
  | 'tabTitle'
  | 'statusTick' | 'statusInflight' | 'statusJobs' | 'statusBreaker' | 'statusCatchUp'
  | 'refresh' | 'newJob'
  | 'newJobTitle' | 'editJobTitle'
  | 'formName' | 'formNamePlaceholder'
  | 'formPrompt' | 'formPromptPlaceholder'
  | 'formTriggerKind' | 'triggerCron' | 'triggerInterval' | 'triggerOnce'
  | 'formExpression' | 'exprPlaceholderCron' | 'exprPlaceholderInterval' | 'exprPlaceholderOnce'
  | 'formTimezone' | 'timezonePlaceholder'
  | 'formWorkspace' | 'workspacePlaceholder'
  | 'formDeliverTo' | 'deliverToPlaceholder'
  | 'formCatchUp' | 'catchUpGlobal' | 'catchUpRunOnce' | 'catchUpSkip'
  | 'formEnabled'
  | 'previewLabel' | 'previewSeparator' | 'previewPending'
  | 'saving' | 'save' | 'cancel'
  | 'noJobs'
  | 'pausedBreaker' | 'paused' | 'enabledBadge' | 'completedBadge' | 'running'
  | 'triggerNow' | 'resume' | 'pause' | 'edit' | 'delete'
  | 'triggerKindCron' | 'triggerKindInterval' | 'triggerKindOnce'
  | 'separator' | 'deliveryTo' | 'catchUpTag'
  | 'nextRun' | 'lastRun' | 'runCount' | 'consecutiveFailures'
  | 'collapseHistory' | 'runHistory' | 'noRuns'
  | 'runManual' | 'runScheduled' | 'triggeredAt' | 'duration' | 'exitCode'
  | 'deliveredTo' | 'deliveryStatus' | 'noOutput'
  | 'emptyDate' | 'justNow' | 'minAgo' | 'hourAgo' | 'dayAgo'
  | 'deleteConfirmTitle' | 'deleteConfirmBody'
  | 'pauseConfirmTitle' | 'pauseConfirmBody'
  | 'resumeConfirmTitle' | 'resumeConfirmBody'
  | 'triggerConfirmTitle' | 'triggerConfirmBody'
  | 'confirmDelete' | 'confirmPause' | 'confirmResume' | 'confirmTrigger'

/** English copy. */
export const en: Record<SchedulerKey, string> = {
  tabTitle: 'Scheduled jobs',
  statusTick: 'tick: {time}',
  statusInflight: 'inflight: {inflight}/{max}',
  statusJobs: 'jobs: {enabled}/{total} enabled',
  statusBreaker: 'breaker: {n} consecutive failures',
  statusCatchUp: 'catch-up: {policy}',
  refresh: 'Refresh',
  newJob: '+ New job',
  newJobTitle: 'New job',
  editJobTitle: 'Edit job: {name}',
  formName: 'Name',
  formNamePlaceholder: 'e.g. Daily CI patrol',
  formPrompt: 'Prompt (runs in a fresh headless session; must be self-contained)',
  formPromptPlaceholder: 'Check CI status and summarize the results',
  formTriggerKind: 'Trigger type',
  triggerCron: 'cron (5-field expression)',
  triggerInterval: 'interval (e.g. 30m / 2h)',
  triggerOnce: 'once (ISO time)',
  formExpression: 'Expression',
  exprPlaceholderCron: '0 9 * * 1-5',
  exprPlaceholderInterval: '30m',
  exprPlaceholderOnce: '2026-08-16T09:00:00+08:00',
  formTimezone: 'Timezone',
  timezonePlaceholder: 'local / Asia/Shanghai',
  formWorkspace: 'Workspace (headless run cwd; empty uses the default)',
  workspacePlaceholder: 'e.g. /path/to/job/workspace',
  formDeliverTo: 'Result delivery session (deliverTo; empty = no delivery)',
  deliverToPlaceholder: 'Target session ID; results follow up there while that session is online',
  formCatchUp: 'Catch-up policy',
  catchUpGlobal: 'Follow global (run_once)',
  catchUpRunOnce: 'run_once (run once after a miss)',
  catchUpSkip: 'skip (skip when too late)',
  formEnabled: 'Enabled',
  previewLabel: 'Next 5 occurrences:',
  previewSeparator: ' | ',
  previewPending: '…',
  saving: 'Saving…',
  save: 'Save',
  cancel: 'Cancel',
  noJobs: 'No scheduled jobs yet — click "+ New job" to create the first one.',
  pausedBreaker: 'Paused (circuit breaker)',
  paused: 'Paused',
  enabledBadge: 'Enabled',
  completedBadge: 'Completed',
  running: 'Running…',
  triggerNow: 'Trigger now',
  resume: 'Resume',
  pause: 'Pause',
  edit: 'Edit',
  delete: 'Delete',
  triggerKindCron: 'cron',
  triggerKindInterval: 'interval',
  triggerKindOnce: 'once',
  separator: ' · ',
  deliveryTo: 'deliver → {id}',
  catchUpTag: 'catch-up: {policy}',
  nextRun: 'next: {time}',
  lastRun: 'last: {time}',
  runCount: '{count} run(s)',
  consecutiveFailures: '{count} consecutive failure(s)',
  collapseHistory: 'Hide history',
  runHistory: 'Run history',
  noRuns: 'No run records',
  runManual: 'manual',
  runScheduled: 'scheduled',
  triggeredAt: 'triggered at {time}',
  duration: '{s}s',
  exitCode: 'exit {code}',
  deliveredTo: 'delivered → {id}',
  deliveryStatus: 'delivery: {status}',
  noOutput: '(no output)',
  emptyDate: '—',
  justNow: 'just now',
  minAgo: '{n}m ago',
  hourAgo: '{n}h ago',
  dayAgo: '{n}d ago',
  deleteConfirmTitle: 'Delete job',
  deleteConfirmBody: 'Delete job "{name}"? Its run ledger will be deleted too.',
  pauseConfirmTitle: 'Pause job',
  pauseConfirmBody: 'Pause job "{name}"? It will stop triggering and can be resumed anytime.',
  resumeConfirmTitle: 'Resume job',
  resumeConfirmBody: 'Resume job "{name}"? It will resume triggering per its schedule.',
  triggerConfirmTitle: 'Trigger now',
  triggerConfirmBody: 'Manually trigger job "{name}"? This creates one manual run.',
  confirmDelete: 'Delete',
  confirmPause: 'Pause',
  confirmResume: 'Resume',
  confirmTrigger: 'Trigger',
}

/** Simplified Chinese copy. */
export const zh: Record<SchedulerKey, string> = {
  tabTitle: '定时任务',
  statusTick: 'tick: {time}',
  statusInflight: '在飞: {inflight}/{max}',
  statusJobs: '任务: {enabled}/{total} 启用',
  statusBreaker: '熔断: {n} 连败',
  statusCatchUp: '追赶: {policy}',
  refresh: '刷新',
  newJob: '+ 新建任务',
  newJobTitle: '新建任务',
  editJobTitle: '编辑任务：{name}',
  formName: '名称',
  formNamePlaceholder: '如：每日 CI 巡检',
  formPrompt: '任务 prompt（headless 全新会话执行，需自包含）',
  formPromptPlaceholder: '检查 CI 状态并汇总结果',
  formTriggerKind: '触发类型',
  triggerCron: 'cron（5 段表达式）',
  triggerInterval: '间隔（如 30m / 2h）',
  triggerOnce: '一次性（ISO 时间）',
  formExpression: '表达式',
  exprPlaceholderCron: '0 9 * * 1-5',
  exprPlaceholderInterval: '30m',
  exprPlaceholderOnce: '2026-08-16T09:00:00+08:00',
  formTimezone: '时区',
  timezonePlaceholder: 'local / Asia/Shanghai',
  formWorkspace: '工作区（headless 运行 cwd，留空用默认）',
  workspacePlaceholder: '如 /path/to/job/workspace',
  formDeliverTo: '结果投递会话（deliverTo，留空不投递）',
  deliverToPlaceholder: '目标会话 ID；该会话在线时结果 followup 进去',
  formCatchUp: '追赶策略',
  catchUpGlobal: '跟随全局（run_once）',
  catchUpRunOnce: 'run_once（错过补跑一次）',
  catchUpSkip: 'skip（超时差即跳过）',
  formEnabled: '启用',
  previewLabel: '未来 5 次触发：',
  previewSeparator: ' ｜ ',
  previewPending: '…',
  saving: '保存中…',
  save: '保存',
  cancel: '取消',
  noJobs: '暂无定时任务，点「+ 新建任务」创建第一个。',
  pausedBreaker: '已熔断暂停',
  paused: '已暂停',
  enabledBadge: '启用',
  completedBadge: '已完成',
  running: '运行中…',
  triggerNow: '立即触发',
  resume: '恢复',
  pause: '暂停',
  edit: '编辑',
  delete: '删除',
  triggerKindCron: 'cron',
  triggerKindInterval: '间隔',
  triggerKindOnce: '一次性',
  separator: ' · ',
  deliveryTo: '投递→{id}',
  catchUpTag: '追赶:{policy}',
  nextRun: '下次: {time}',
  lastRun: '上次: {time}',
  runCount: '运行 {count} 次',
  consecutiveFailures: '连续失败 {count}',
  collapseHistory: '收起历史',
  runHistory: '运行历史',
  noRuns: '暂无运行记录',
  runManual: '手动',
  runScheduled: '定时',
  triggeredAt: '触发于 {time}',
  duration: '耗时 {s}s',
  exitCode: 'exit {code}',
  deliveredTo: '已投递→{id}',
  deliveryStatus: '投递:{status}',
  noOutput: '（无输出）',
  emptyDate: '—',
  justNow: '刚刚',
  minAgo: '{n} 分钟前',
  hourAgo: '{n} 小时前',
  dayAgo: '{n} 天前',
  deleteConfirmTitle: '删除任务',
  deleteConfirmBody: '删除任务「{name}」？运行台账将一并删除。',
  pauseConfirmTitle: '暂停任务',
  pauseConfirmBody: '暂停任务「{name}」？暂停后不会触发，可随时恢复。',
  resumeConfirmTitle: '恢复任务',
  resumeConfirmBody: '恢复任务「{name}」？恢复后按原计划继续触发。',
  triggerConfirmTitle: '立即触发',
  triggerConfirmBody: '立即触发任务「{name}」？将创建一次手动运行。',
  confirmDelete: '删除',
  confirmPause: '暂停',
  confirmResume: '恢复',
  confirmTrigger: '触发',
}

/** The dictionary namespace this tab owns (registered via ctx.locale). */
export const NS = 'scheduler'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This tab's conversation-view copy. */
    scheduler: SchedulerKey
  }
}
