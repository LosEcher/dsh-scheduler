/**
 * dsh-scheduler — client entry: registers a '定时任务' conversation tab
 * ('conversation.view' slot) backed by the host half's /scheduler API.
 */
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SchedulerTabView } from './SchedulerTabView.tsx'

export const inject = ['slots', 'conversation']

export function apply(ctx: Context) {
  let disposeTab: (() => void) | undefined
  disposeTab = ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: 'scheduler',
      order: 96,
      label: () => '定时任务',
    }, (props) => SchedulerTabView({ ...props })))

  ctx.on('dispose', () => disposeTab?.())
}
