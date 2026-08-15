/**
 * dsh-scheduler — management tab view.
 *
 * Fetches the host half's /scheduler API (same-origin) and renders:
 *   - runtime status strip
 *   - job list with trigger / next-run / last status / actions
 *   - create+edit form with live trigger preview
 *   - per-job run ledger (status, duration, exit code, output tail)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

// ---- styles (inline, CSS-var driven like the rest of the shell) ----

const CARD = {
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  padding: '12px 16px',
  marginBottom: 12,
}
const ROW = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const BTN = {
  padding: '4px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
  border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-text-1)',
}
const BTN_PRIMARY = { ...BTN, background: 'var(--dsw-alias-accent-1, #4a6cf7)', color: '#fff', borderColor: 'transparent' }
const INPUT = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, fontSize: 13,
  border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-text-1)', fontFamily: 'inherit',
}
const BADGE = {
  padding: '2px 8px', borderRadius: 999, fontSize: 11, border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
}
const BADGE_OK = { ...BADGE, color: '#2e9e5b', borderColor: '#2e9e5b55' }
const BADGE_BAD = { ...BADGE, color: '#d64545', borderColor: '#d6454555' }
const MUTED = { color: 'var(--dsw-alias-text-2)', fontSize: 12 }
const TITLE = { margin: '0 0 8px', fontSize: 14, fontWeight: 600 }

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
}

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

const fmt = (iso: string | null | undefined) => {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

const TRIGGER_DESC: Record<TriggerKind, string> = {
  cron: 'cron', interval: '间隔', once: '一次性',
}

// ---- view ----

export function SchedulerTabView(_props: ConvViewProps) {
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
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const [form, setForm] = useState({
    name: '', prompt: '', kind: 'cron' as TriggerKind, expression: '0 9 * * *',
    timezone: 'local', workspace: '', enabled: true,
  })

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
    setForm({ name: '', prompt: '', kind: 'cron', expression: '0 9 * * *', timezone: 'local', workspace: '', enabled: true })
    setShowForm(true)
  }

  const openEdit = (job: Job) => {
    setEditing(job)
    setForm({
      name: job.name, prompt: job.prompt, kind: job.trigger.kind,
      expression: job.trigger.expression, timezone: job.trigger.timezone,
      workspace: job.workspace ?? '', enabled: job.enabled,
    })
    setShowForm(true)
  }

  const submitForm = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const payload = {
        name: form.name, prompt: form.prompt,
        trigger: { kind: form.kind, expression: form.expression, timezone: form.timezone },
        workspace: form.workspace, enabled: form.enabled,
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

  const del = async (job: Job) => {
    if (!confirm(`删除任务「${job.name}」？运行台账将一并删除。`)) return
    await act('DELETE', `/scheduler/jobs/${job.id}`)
    if (runsFor === job.id) { setRuns([]); setRunsFor(null) }
  }

  const inflightIds = useMemo(() => new Set((status?.inflight ?? []).map((i) => i.jobId)), [status])

  return (
    <div style={{ padding: '12px 16px', maxWidth: 900, margin: '0 auto' }}>
      {/* status strip */}
      <div style={CARD}>
        <div style={ROW}>
          <strong style={{ fontSize: 14 }}>定时任务</strong>
          <span style={MUTED}>tick: {fmt(status?.lastTickAt)}</span>
          <span style={MUTED}>在飞: {status?.inflight.length ?? 0}/{status?.maxConcurrent ?? '?'}</span>
          <span style={MUTED}>任务: {status?.enabledCount ?? '?'}/{status?.jobCount ?? '?'} 启用</span>
          <span style={{ flex: 1 }} />
          <button style={BTN} type="button" onClick={() => void load()} disabled={loading}>刷新</button>
          <button style={BTN_PRIMARY} type="button" onClick={openCreate}>+ 新建任务</button>
        </div>
        {error ? <div style={{ color: '#d64545', fontSize: 12, marginTop: 6 }}>{error}</div> : null}
      </div>

      {/* create / edit form */}
      {showForm ? (
        <div style={CARD}>
          <h3 style={TITLE}>{editing ? `编辑任务：${editing.name}` : '新建任务'}</h3>
          <form onSubmit={(e) => void submitForm(e)} style={{ display: 'grid', gap: 8 }}>
            <label style={{ fontSize: 12 }}>名称
              <input style={INPUT} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：每日 CI 巡检" required />
            </label>
            <label style={{ fontSize: 12 }}>任务 prompt（headless 全新会话执行，需自包含）
              <textarea style={{ ...INPUT, minHeight: 72, resize: 'vertical' }} value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })} placeholder="检查 CI 状态并汇总结果" required />
            </label>
            <div style={{ ...ROW, alignItems: 'flex-end' }}>
              <label style={{ fontSize: 12, flex: 1 }}>触发类型
                <select style={INPUT} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as TriggerKind })}>
                  <option value="cron">cron（5 段表达式）</option>
                  <option value="interval">间隔（如 30m / 2h）</option>
                  <option value="once">一次性（ISO 时间）</option>
                </select>
              </label>
              <label style={{ fontSize: 12, flex: 2 }}>表达式
                <input style={INPUT} value={form.expression}
                  onChange={(e) => setForm({ ...form, expression: e.target.value })}
                  placeholder={form.kind === 'cron' ? '0 9 * * 1-5' : form.kind === 'interval' ? '30m' : '2026-08-16T09:00:00+08:00'} required />
              </label>
              <label style={{ fontSize: 12, flex: 1 }}>时区
                <input style={INPUT} value={form.timezone}
                  onChange={(e) => setForm({ ...form, timezone: e.target.value })} placeholder="local / Asia/Shanghai" />
              </label>
            </div>
            <label style={{ fontSize: 12 }}>工作区（headless 运行 cwd，留空用默认）
              <input style={INPUT} value={form.workspace}
                onChange={(e) => setForm({ ...form, workspace: e.target.value })}
                placeholder="如 /Users/echerlos/syncthing/project/dsfolder" />
            </label>
            <label style={{ fontSize: 12, ...ROW }}><input type="checkbox" checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 启用</label>
            <div style={{ fontSize: 12 }}>
              <strong>未来 5 次触发：</strong>
              {preview ? (
                <span style={{ ...MUTED, wordBreak: 'break-all' }}>{preview.map(fmt).join(' ｜ ')}</span>
              ) : previewError ? (
                <span style={{ color: '#d64545' }}>{previewError}</span>
              ) : (<span style={MUTED}>…</span>)}
            </div>
            <div style={ROW}>
              <button style={BTN_PRIMARY} type="submit" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
              <button style={BTN} type="button" onClick={() => { setShowForm(false); setEditing(null) }}>取消</button>
            </div>
          </form>
        </div>
      ) : null}

      {/* job list */}
      {jobs.length === 0 && !loading ? (
        <div style={CARD}><span style={MUTED}>暂无定时任务，点「+ 新建任务」创建第一个。</span></div>
      ) : jobs.map((job) => {
        const running = inflightIds.has(job.id)
        return (
          <div key={job.id} style={CARD}>
            <div style={ROW}>
              <strong>{job.name}</strong>
              {job.enabled && job.state === 'scheduled'
                ? <span style={BADGE_OK}>启用</span>
                : <span style={BADGE_BAD}>{job.state === 'paused' ? '已暂停' : '已完成'}</span>}
              {running ? <span style={BADGE}>运行中…</span> : null}
              <span style={{ flex: 1 }} />
              <button style={BTN} type="button" onClick={() => void act('POST', `/scheduler/jobs/${job.id}/trigger`)} disabled={running}>立即触发</button>
              {job.state === 'paused'
                ? <button style={BTN} type="button" onClick={() => void act('POST', `/scheduler/jobs/${job.id}/resume`)}>恢复</button>
                : <button style={BTN} type="button" onClick={() => void act('POST', `/scheduler/jobs/${job.id}/pause`)}>暂停</button>}
              <button style={BTN} type="button" onClick={() => openEdit(job)}>编辑</button>
              <button style={BTN} type="button" onClick={() => void del(job)}>删除</button>
            </div>
            <div style={{ ...MUTED, marginTop: 4 }}>
              {TRIGGER_DESC[job.trigger.kind]} {job.trigger.expression} · {job.trigger.timezone}
              {job.workspace ? ` · ${job.workspace}` : ''}
            </div>
            <div style={{ ...ROW, marginTop: 4 }}>
              <span style={MUTED}>下次: <b>{fmt(job.nextRunAt)}</b></span>
              <span style={MUTED}>上次: {fmt(job.lastRunAt)}</span>
              {job.lastStatus
                ? <span style={job.lastStatus === 'succeeded' ? BADGE_OK : BADGE_BAD}>{job.lastStatus}</span>
                : null}
              <span style={MUTED}>运行 {job.runCount} 次</span>
              {job.consecutiveFailures > 0 ? <span style={BADGE_BAD}>连续失败 {job.consecutiveFailures}</span> : null}
              <span style={{ flex: 1 }} />
              <button style={{ ...BTN, fontSize: 11 }} type="button"
                onClick={() => void (runsFor === job.id ? (setRuns([]), setRunsFor(null)) : loadRuns(job.id))}>
                {runsFor === job.id ? '收起历史' : '运行历史'}
              </button>
            </div>

            {/* run ledger for this job */}
            {runsFor === job.id ? (
              <div style={{ marginTop: 8, borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 8 }}>
                {runs.length === 0 ? <span style={MUTED}>暂无运行记录</span> : runs.map((r) => (
                  <details key={r.id} style={{ marginBottom: 6, fontSize: 12 }}>
                    <summary style={{ cursor: 'pointer' }}>
                      <span style={ROW}>
                        <span style={r.status === 'succeeded' ? BADGE_OK : r.status === 'failed' ? BADGE_BAD : BADGE}>{r.status}</span>
                        <span style={MUTED}>{r.triggerKind === 'manual' ? '手动' : '定时'}</span>
                        <span style={MUTED}>触发于 {fmt(r.scheduledFor)}</span>
                        {r.durationMs !== undefined ? <span style={MUTED}>耗时 {(r.durationMs / 1000).toFixed(1)}s</span> : null}
                        {r.exitCode !== undefined ? <span style={MUTED}>exit {r.exitCode}</span> : null}
                        <span style={{ flex: 1 }} />
                        <span style={MUTED}>{fmt(r.completedAt ?? r.startedAt)}</span>
                      </span>
                    </summary>
                    {r.error ? <pre style={{ ...MUTED, color: '#d64545', whiteSpace: 'pre-wrap', margin: '4px 0' }}>{r.error}</pre> : null}
                    {r.outputHead ? (
                      <pre style={{ ...MUTED, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '4px 0', maxHeight: 240, overflow: 'auto' }}>
                        {r.outputHead}
                      </pre>
                    ) : <span style={MUTED}>（无输出）</span>}
                  </details>
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
