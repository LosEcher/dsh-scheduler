/**
 * dsh-scheduler — management tab view.
 *
 * Fetches the host half's /scheduler API (same-origin) and renders:
 *   - runtime status strip
 *   - job list with trigger / next-run / last status / actions
 *   - create+edit form with live trigger preview
 *   - per-job run ledger (status, duration, exit code, output tail)
 *
 * Follows the standard DSH plugin client style (see
 * dsh-plugin-operations「标准插件卡片写法」):
 *   - All styles through a CSS module with --dsw-alias-* design tokens
 *     (theme-aware; no inline styles, no hardcoded colors).
 *   - All copy through the injected `t` seat (locale namespace `scheduler`;
 *     zh/en dictionaries in locales.ts).
 *   - ui-primitives atoms (Button, Modal); destructive actions (delete,
 *     pause/resume, manual trigger) go through a Modal — never
 *     window.confirm.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconTrashOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from './locales.ts'
import css from './SchedulerTab.module.css'
import { StatusBadge } from './StatusBadge.tsx'

// ---- types (mirror the host API) ----

type TriggerKind = 'cron' | 'interval' | 'once'
interface Trigger { kind: TriggerKind; expression: string; timezone: string; everySeconds?: number }
interface Job {
  id: string
  name: string
  prompt: string
  trigger: Trigger
  workspace: string
  enabled: boolean
  state: 'scheduled' | 'paused' | 'completed'
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: 'succeeded' | 'failed' | 'skipped' | null
  runCount: number
  consecutiveFailures: number
  deliverTo?: { sessionId: string }
  catchUpPolicy?: 'run_once' | 'skip'
  pausedReason?: string
  createdAt: string
  updatedAt: string
}
interface Run {
  id: string
  jobId: string
  triggerKind: 'scheduled' | 'manual'
  scheduledFor: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
  exitCode?: number
  durationMs?: number
  outputHead?: string
  error?: string
  delivery?: { status: 'delivered' | 'skipped' | 'error'; sessionId?: string; reason?: string }
  startedAt?: string
  completedAt?: string
}
interface Status {
  ok: boolean
  lastTickAt: string | null
  inflight: { jobId: string; runId: string }[]
  jobCount: number
  enabledCount: number
  maxConcurrent: number
  timeoutMs: number
  killGraceMs: number
  maxConsecutiveFailures: number
  catchUpPolicy: 'run_once' | 'skip'
  maxLatenessMs: number
}

/** Destructive action awaiting Modal confirmation. */
type ConfirmKind = 'delete' | 'pause' | 'resume' | 'trigger'

/** Props delivered by the slot outlet: runtime share + locale seat. */
export type SchedulerTabViewProps = PropsRuntime<'conversation.view'> & PropsLocale<typeof import('./locales.ts').NS>

// ---- api helpers ----

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal })
  const body = await res.json()
  if (!res.ok) throw new Error((body as { message?: string })?.message ?? `HTTP ${res.status}`)
  return body as T
}
async function sendJson(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error((data as { message?: string })?.message ?? `HTTP ${res.status}`)
  return data
}

// ---- view ----

export function SchedulerTabView({ t }: SchedulerTabViewProps) {
  const [status, setStatus] = useState<Status | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [runsFor, setRunsFor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Job | null>(null)
  const [preview, setPreview] = useState<string[] | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<{ kind: ConfirmKind; job: Job } | null>(null)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const [form, setForm] = useState({
    name: '', prompt: '', kind: 'cron' as TriggerKind, expression: '0 9 * * *',
    timezone: 'local', workspace: '', enabled: true,
    deliverTo: '', catchUpPolicy: '',
  })

  const fmt = useCallback((iso: string | null | undefined): string => {
    if (!iso) return t('emptyDate')
    try {
      return new Date(iso).toLocaleString('zh-CN', { hour12: false })
    } catch {
      return iso
    }
  }, [t])

  /** 相对时间（Task Rows 风格）：<1m → '刚刚'，<1h → 'Nm ago'，<24h → 'Nh ago'，否则绝对日期 */
  const relTime = useCallback((iso: string | null | undefined): string => {
    if (!iso) return t('emptyDate')
    const ts = new Date(iso).getTime()
    if (Number.isNaN(ts)) return iso
    const diff = Date.now() - ts
    if (diff < 60_000) return t('justNow')
    const m = Math.floor(diff / 60_000)
    if (m < 60) return t('minAgo', { n: m })
    const h = Math.floor(m / 60)
    if (h < 24) return t('hourAgo', { n: h })
    const d = Math.floor(h / 24)
    if (d < 7) return t('dayAgo', { n: d })
    return new Date(ts).toLocaleDateString('zh-CN')
  }, [t])

  /** 输出尾部首行（单行截断，Task Rows 风格） */
  const outputTail = useCallback((head: string | undefined): string => {
    if (!head) return ''
    const line = head.split('\n')[0].trim()
    return line.length > 80 ? `${line.slice(0, 80)}…` : line
  }, [])

  const triggerKindLabel = useCallback((kind: TriggerKind): string => {
    if (kind === 'cron') return t('triggerKindCron')
    if (kind === 'interval') return t('triggerKindInterval')
    return t('triggerKindOnce')
  }, [t])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, j] = await Promise.all([
        getJson<Status>('/scheduler/status'),
        getJson<{ results: Job[] }>('/scheduler/jobs'),
      ])
      setStatus(s)
      setJobs(j.results ?? [])
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const loadRuns = useCallback(async (jobId: string) => {
    try {
      const d = await getJson<{ runs: Run[] }>(`/scheduler/jobs/${jobId}/runs?limit=30`)
      setRuns(d.runs ?? [])
      setRunsFor(jobId)
    } catch {
      setRuns([])
      setRunsFor(null)
    }
  }, [])

  // Debounced trigger preview while the form is open.
  useEffect(() => {
    if (!showForm) return
    if (!form.expression.trim()) { setPreview(null); setPreviewError(null); return }
    clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(async () => {
      const q = new URLSearchParams({ kind: form.kind, expression: form.expression, timezone: form.timezone, n: '5' })
      try {
        const d = await getJson<{ occurrences: string[] }>(`/scheduler/preview?${q}`)
        setPreview(d.occurrences)
        setPreviewError(null)
      } catch (e) {
        setPreview(null)
        setPreviewError(String((e as Error).message ?? e))
      }
    }, 400)
    return () => clearTimeout(previewTimer.current)
  }, [showForm, form.kind, form.expression, form.timezone])

  const openCreate = () => {
    setEditing(null)
    setForm({
      name: '', prompt: '', kind: 'cron', expression: '0 9 * * *', timezone: 'local',
      workspace: '', enabled: true, deliverTo: '', catchUpPolicy: '',
    })
    setShowForm(true)
  }

  const openEdit = (job: Job) => {
    setEditing(job)
    setForm({
      name: job.name, prompt: job.prompt, kind: job.trigger.kind,
      expression: job.trigger.expression, timezone: job.trigger.timezone,
      workspace: job.workspace ?? '', enabled: job.enabled,
      deliverTo: job.deliverTo?.sessionId ?? '',
      catchUpPolicy: job.catchUpPolicy ?? '',
    })
    setShowForm(true)
  }

  const submitForm = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const payload: Record<string, unknown> = {
        name: form.name, prompt: form.prompt,
        trigger: { kind: form.kind, expression: form.expression, timezone: form.timezone },
        workspace: form.workspace, enabled: form.enabled,
        deliverTo: form.deliverTo.trim() ? { sessionId: form.deliverTo.trim() } : null,
        catchUpPolicy: form.catchUpPolicy || undefined,
      }
      if (editing) {
        await sendJson('PATCH', `/scheduler/jobs/${editing.id}`, payload)
      } else {
        await sendJson('POST', '/scheduler/jobs', payload)
      }
      setShowForm(false)
      setEditing(null)
      await load()
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const act = async (method: string, path: string) => {
    try {
      await sendJson(method, path)
      await load()
    } catch (e) {
      setError(String((e as Error).message ?? e))
    }
  }

  /** Run the Modal-confirmed destructive action. */
  const runConfirmed = async () => {
    if (!confirming) return
    const { kind, job } = confirming
    setConfirming(null)
    if (kind === 'delete') {
      await act('DELETE', `/scheduler/jobs/${job.id}`)
      if (runsFor === job.id) { setRuns([]); setRunsFor(null) }
      return
    }
    if (kind === 'pause') { await act('POST', `/scheduler/jobs/${job.id}/pause`); return }
    if (kind === 'resume') { await act('POST', `/scheduler/jobs/${job.id}/resume`); return }
    await act('POST', `/scheduler/jobs/${job.id}/trigger`)
  }

  const confirmMeta = (kind: ConfirmKind) => {
    switch (kind) {
      case 'delete': return { title: t('deleteConfirmTitle'), body: t('deleteConfirmBody', { name: confirming?.job.name ?? '' }), label: t('confirmDelete') }
      case 'pause': return { title: t('pauseConfirmTitle'), body: t('pauseConfirmBody', { name: confirming?.job.name ?? '' }), label: t('confirmPause') }
      case 'resume': return { title: t('resumeConfirmTitle'), body: t('resumeConfirmBody', { name: confirming?.job.name ?? '' }), label: t('confirmResume') }
      case 'trigger': return { title: t('triggerConfirmTitle'), body: t('triggerConfirmBody', { name: confirming?.job.name ?? '' }), label: t('confirmTrigger') }
    }
  }

  const inflightIds = useMemo(() => new Set((status?.inflight ?? []).map((i) => i.jobId)), [status])

  return (
    <div className={css.scRoot}>
      {/* status strip */}
      <div className={css.scCard}>
        <div className={css.scRow}>
          <strong className={css.scStatusTitle}>{t('tabTitle')}</strong>
          <span className={css.scMuted}>{t('statusTick', { time: fmt(status?.lastTickAt) })}</span>
          <span className={css.scMuted}>{t('statusInflight', { inflight: status?.inflight.length ?? 0, max: status?.maxConcurrent ?? '?' })}</span>
          <span className={css.scMuted}>{t('statusJobs', { enabled: status?.enabledCount ?? '?', total: status?.jobCount ?? '?' })}</span>
          <span className={css.scMuted}>{t('statusBreaker', { n: status?.maxConsecutiveFailures ?? '?' })}</span>
          <span className={css.scMuted}>{t('statusCatchUp', { policy: status?.catchUpPolicy ?? '?' })}</span>
          <span className={css.scSpacer} />
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>{t('refresh')}</Button>
          <Button variant="primary" size="sm" onClick={openCreate}>{t('newJob')}</Button>
        </div>
        {error !== null && <div className={css.scError}>{error}</div>}
      </div>

      {/* create / edit form */}
      {showForm ? (
        <div className={css.scCard}>
          <h3 className={css.scTitle}>{editing ? t('editJobTitle', { name: editing.name }) : t('newJobTitle')}</h3>
          <form className={css.scForm} onSubmit={(e) => void submitForm(e)}>
            <label className={css.scFieldLabel}>{t('formName')}
              <input className={css.scInput} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('formNamePlaceholder')} required />
            </label>
            <label className={css.scFieldLabel}>{t('formPrompt')}
              <textarea className={`${css.scInput} ${css.scTextarea}`} value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })} placeholder={t('formPromptPlaceholder')} required />
            </label>
            <div className={`${css.scRow} ${css.scRowEnd}`}>
              <label className={`${css.scFieldLabel} ${css.scFieldFlex1}`}>{t('formTriggerKind')}
                <select className={css.scSelect} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as TriggerKind })}>
                  <option value="cron">{t('triggerCron')}</option>
                  <option value="interval">{t('triggerInterval')}</option>
                  <option value="once">{t('triggerOnce')}</option>
                </select>
              </label>
              <label className={`${css.scFieldLabel} ${css.scFieldFlex2}`}>{t('formExpression')}
                <input className={css.scInput} value={form.expression}
                  onChange={(e) => setForm({ ...form, expression: e.target.value })}
                  placeholder={t(form.kind === 'cron' ? 'exprPlaceholderCron' : form.kind === 'interval' ? 'exprPlaceholderInterval' : 'exprPlaceholderOnce')} required />
              </label>
              <label className={`${css.scFieldLabel} ${css.scFieldFlex1}`}>{t('formTimezone')}
                <input className={css.scInput} value={form.timezone}
                  onChange={(e) => setForm({ ...form, timezone: e.target.value })} placeholder={t('timezonePlaceholder')} />
              </label>
            </div>
            <label className={css.scFieldLabel}>{t('formWorkspace')}
              <input className={css.scInput} value={form.workspace}
                onChange={(e) => setForm({ ...form, workspace: e.target.value })} placeholder={t('workspacePlaceholder')} />
            </label>
            <div className={`${css.scRow} ${css.scRowEnd}`}>
              <label className={`${css.scFieldLabel} ${css.scFieldFlex2}`}>{t('formDeliverTo')}
                <input className={css.scInput} value={form.deliverTo}
                  onChange={(e) => setForm({ ...form, deliverTo: e.target.value })} placeholder={t('deliverToPlaceholder')} />
              </label>
              <label className={`${css.scFieldLabel} ${css.scFieldFlex1}`}>{t('formCatchUp')}
                <select className={css.scSelect} value={form.catchUpPolicy}
                  onChange={(e) => setForm({ ...form, catchUpPolicy: e.target.value })}>
                  <option value="">{t('catchUpGlobal')}</option>
                  <option value="run_once">{t('catchUpRunOnce')}</option>
                  <option value="skip">{t('catchUpSkip')}</option>
                </select>
              </label>
            </div>
            <label className={css.scCheckRow}><input type="checkbox" checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> {t('formEnabled')}</label>
            <div className={css.scPreview}>
              <strong className={css.scPreviewLabel}>{t('previewLabel')}</strong>
              {preview ? (
                <span className={css.scPreviewValue}>{preview.map((iso) => fmt(iso)).join(t('previewSeparator'))}</span>
              ) : previewError ? (
                <span className={css.scPreviewError}>{previewError}</span>
              ) : (<span className={css.scMuted}>{t('previewPending')}</span>)}
            </div>
            <div className={css.scRow}>
              <Button variant="primary" size="sm" type="submit" disabled={busy}>{busy ? t('saving') : t('save')}</Button>
              <Button variant="ghost" size="sm" onClick={() => { setShowForm(false); setEditing(null) }}>{t('cancel')}</Button>
            </div>
          </form>
        </div>
      ) : null}

      {/* job list */}
      {jobs.length === 0 && !loading ? (
        <div className={css.scCard}><span className={css.scMuted}>{t('noJobs')}</span></div>
      ) : jobs.map((job) => {
        const running = inflightIds.has(job.id)
        return (
          <div key={job.id} className={css.scCard}>
            <div className={css.scRow}>
              <strong>{job.name}</strong>
              {job.state === 'paused'
                ? <StatusBadge state="bad">{job.pausedReason === 'max_consecutive_failures' ? t('pausedBreaker') : t('paused')}</StatusBadge>
                : job.enabled && job.state === 'scheduled' ? <StatusBadge state="ok">{t('enabledBadge')}</StatusBadge> : <StatusBadge state="bad">{t('completedBadge')}</StatusBadge>}
              {running ? <StatusBadge state="neutral">{t('running')}</StatusBadge> : null}
              <span className={css.scSpacer} />
              <Button variant="outline" size="sm" disabled={running} onClick={() => setConfirming({ kind: 'trigger', job })}>{t('triggerNow')}</Button>
              {job.state === 'paused'
                ? <Button variant="outline" size="sm" onClick={() => setConfirming({ kind: 'resume', job })}>{t('resume')}</Button>
                : <Button variant="outline" size="sm" onClick={() => setConfirming({ kind: 'pause', job })}>{t('pause')}</Button>}
              <Button variant="ghost" size="sm" onClick={() => openEdit(job)}>{t('edit')}</Button>
              <Button variant="ghost" size="sm" icon={<IconTrashOutline16 />} className={css.scDangerText} onClick={() => setConfirming({ kind: 'delete', job })}>{t('delete')}</Button>
            </div>
            <div className={css.scJobMeta}>
              {[
                `${triggerKindLabel(job.trigger.kind)} ${job.trigger.expression} ${job.trigger.timezone}`,
                job.workspace ? job.workspace : null,
                job.deliverTo ? t('deliveryTo', { id: job.deliverTo.sessionId }) : null,
                job.catchUpPolicy ? t('catchUpTag', { policy: job.catchUpPolicy }) : null,
              ].filter(Boolean).join(t('separator'))}
            </div>
            <div className={css.scJobActions}>
              <span className={css.scMuted}>{t('nextRun', { time: fmt(job.nextRunAt) })}</span>
              <span className={css.scMuted}>{t('lastRun', { time: fmt(job.lastRunAt) })}</span>
              {job.lastStatus
                ? <StatusBadge state={job.lastStatus === 'succeeded' ? 'ok' : 'bad'}>{job.lastStatus}</StatusBadge>
                : null}
              <span className={css.scMuted}>{t('runCount', { count: job.runCount })}</span>
              {job.consecutiveFailures > 0 ? <StatusBadge state="bad">{t('consecutiveFailures', { count: job.consecutiveFailures })}</StatusBadge> : null}
              <span className={css.scSpacer} />
              <Button variant="ghost" size="sm"
                onClick={() => void (runsFor === job.id ? (setRuns([]), setRunsFor(null)) : loadRuns(job.id))}>
                {runsFor === job.id ? t('collapseHistory') : t('runHistory')}
              </Button>
            </div>

            {/* run ledger for this job */}
            {runsFor === job.id ? (
              <div className={css.scLedger}>
                {runs.length === 0 ? <span className={css.scMuted}>{t('noRuns')}</span> : runs.map((r) => (
                  <details key={r.id} className={css.scRunItem}>
                    <summary className={css.scRunSummary}>
                      <span className={css.scRow}>
                        <StatusBadge state={r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'bad' : 'neutral'}>{r.status}</StatusBadge>
                        <span className={css.scMuted}>{r.triggerKind === 'manual' ? t('runManual') : t('runScheduled')}</span>
                        {r.durationMs !== undefined ? <span className={css.scMuted}>{t('duration', { s: (r.durationMs / 1000).toFixed(1) })}</span> : null}
                        {r.exitCode !== undefined ? <span className={css.scMuted}>{t('exitCode', { code: r.exitCode })}</span> : null}
                        {r.delivery
                          ? <StatusBadge state={r.delivery.status === 'delivered' ? 'ok' : r.delivery.status === 'error' ? 'bad' : 'neutral'}>
                              {r.delivery.status === 'delivered' ? t('deliveredTo', { id: r.delivery.sessionId ?? '' }) : t('deliveryStatus', { status: r.delivery.status })}
                            </StatusBadge>
                          : null}
                        <span className={css.scSpacer} />
                        {/* Task Rows 风格：相对时间 + title 全时间戳；输出尾部单行截断 */}
                        <span className={css.scRunTail} title={r.outputHead ?? undefined}>
                          {outputTail(r.outputHead) || t('noOutput')}
                        </span>
                        <span className={css.scMuted} title={fmt(r.completedAt ?? r.startedAt)}>
                          {relTime(r.completedAt ?? r.startedAt)}
                        </span>
                      </span>
                    </summary>
                    {r.error ? <pre className={css.scRunError}>{r.error}</pre> : null}
                    {r.outputHead ? (
                      <pre className={css.scRunOutput}>{r.outputHead}</pre>
                    ) : <span className={css.scMuted}>{t('noOutput')}</span>}
                  </details>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}

      {/* destructive-action confirmation — Modal, never window.confirm */}
      {confirming !== null && (
        <Modal
          open
          onClose={() => setConfirming(null)}
          title={confirmMeta(confirming.kind).title}
          closeLabel={t('cancel')}
          description={confirmMeta(confirming.kind).body}
          footer={(
            <>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>{t('cancel')}</Button>
              <Button variant="primary" size="sm" onClick={() => void runConfirmed()}>
                {confirmMeta(confirming.kind).label}
              </Button>
            </>
          )}
        />
      )}
    </div>
  )
}
