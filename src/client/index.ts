/**
 * dsh-scheduler — client entry: registers a sidebar footer action
 * ('sidebar.footer.action' slot) backed by the host half's /scheduler API.
 *
 * Standard wiring (see dsh-plugin-operations「标准插件卡片写法」):
 *   - `ctx.locale.register(NS, { zh, en })` installs the dictionary under
 *     the `scheduler` namespace; the slot registration passes `locale: NS`
 *     so the renderer synthesizes the typed `t` seat.
 *   - The action label reads through the bound translate as a thunk, so it
 *     follows the active locale without re-registration.
 */
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { SchedulerFooterAction } from './SchedulerFooterAction.tsx'
import { NS, en, zh } from './locales.ts'

export const inject = ['slots', 'locale']

export function apply(ctx: Context) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-scheduler: dictionaries')

  // Registration-time text reads through the bound translate as a thunk, so
  // it follows the active locale; the component reads the standard `t` seat.
  const t = ctx.locale.bind(NS)

  let disposeAction: (() => void) | undefined
  disposeAction = ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'scheduler',
      order: 90,
      locale: NS,
      label: () => t('tabTitle'),
    }, (props) => SchedulerFooterAction({ ...props })))

  ctx.on('dispose', () => disposeAction?.())
}
