/**
 * dsh-scheduler — client entry: registers a scheduled-jobs conversation tab
 * ('conversation.view' slot) backed by the host half's /scheduler API.
 *
 * Standard wiring (see dsh-plugin-operations「标准插件卡片写法」):
 *   - `ctx.locale.register(NS, { zh, en })` installs the dictionary under
 *     the `scheduler` namespace; the slot registration passes `locale: NS`
 *     so the renderer synthesizes the typed `t` seat.
 *   - The tab label reads through the bound translate as a thunk, so it
 *     follows the active locale without re-registration.
 */
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SchedulerTabView } from './SchedulerTabView.tsx'
import { NS, en, zh } from './locales.ts'

export const inject = ['slots', 'conversation', 'locale']

export function apply(ctx: Context) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-scheduler: dictionaries')

  // Registration-time text (the tab label) reads through the bound translate
  // as a thunk, so it follows the active locale; the component reads the
  // standard `t` seat instead.
  const t = ctx.locale.bind(NS)

  let disposeTab: (() => void) | undefined
  disposeTab = ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: 'scheduler',
      order: 96,
      locale: NS,
      label: () => t('tabTitle'),
    }, (props) => SchedulerTabView({ ...props })))

  ctx.on('dispose', () => disposeTab?.())
}
