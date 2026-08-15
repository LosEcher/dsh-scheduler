/**
 * dsh-scheduler — sidebar footer action: a compact clock trigger beside
 * Settings with a live running-job badge. Clicking opens the full scheduler
 * management panel in a Modal (reuses SchedulerTabView).
 *
 * Why the sidebar: scheduled jobs are a workspace/global operational console,
 * not a session content view — a `conversation.view` tab forced the user to
 * leave the chat to administer jobs and hid their state until opened. The
 * footer action keeps the running count always visible and defers the full
 * panel to an on-demand dialog.
 */
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { IconQueueOutline14, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { SchedulerTabView } from './SchedulerTabView.tsx'
import { NS } from './locales.ts'
import css from './SchedulerFooterAction.module.css'

export type SchedulerFooterActionProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<typeof NS>

const STATUS_API = '/scheduler/status'
const POLL_MS = 15_000

interface StatusPayload {
  ok: boolean
  inflight: { jobId: string; runId: string }[]
}

/** Sidebar foot trigger: clock icon + running-job badge; opens the panel. */
export function SchedulerFooterAction({ wide, t }: SchedulerFooterActionProps) {
  const [open, setOpen] = useState(false)
  const [inflight, setInflight] = useState(0)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | undefined

    const poll = (): void => {
      void fetch(STATUS_API)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((data: StatusPayload) => {
          if (cancelled) return
          setInflight(data.inflight?.length ?? 0)
        })
        .catch(() => { /* badge is best-effort; the panel still works */ })
    }
    poll()
    timer = setInterval(poll, POLL_MS)

    return () => {
      cancelled = true
      if (timer !== undefined) clearInterval(timer)
    }
  }, [])

  const label = inflight > 0 ? t('statusInflightBadge', { count: inflight }) : t('tabTitle')

  return (
    <>
      <button
        type="button"
        className={css.trigger}
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {wide ? <IconQueueOutline14 size={16} /> : <IconQueueOutline14 size={18} />}
        {wide && <span className={css.label}>{t('tabTitle')}</span>}
        {inflight > 0 && <span className={css.badge}>{inflight}</span>}
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('tabTitle')}
        closeLabel={t('close')}
        className={css.modal}
        contentClassName={css.modalContent}
      >
        <SchedulerTabView t={t} />
      </Modal>
    </>
  )
}
