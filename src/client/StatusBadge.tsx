/**
 * StatusBadge — 状态徽章（非颜色编码通道，WCAG 1.4.1）。
 *
 * 组合 primitives 的 StateDot（状态点，aria-hidden）与文字标签：
 * 色盲用户（~8% 男性）无法仅靠颜色区分状态，点+文字双重编码。
 * 样式走 SchedulerTab.module.css 的 scBadge*（令牌白名单，随主题）。
 */

import type { ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './SchedulerTab.module.css'

/** 语义状态 → scBadge 变体类 */
export function badgeClass(state: 'ok' | 'bad' | 'neutral'): string {
  return state === 'ok' ? css.scBadgeOk : state === 'bad' ? css.scBadgeBad : css.scBadge
}

/** 语义状态 → StateDot 状态（done/ongoing/warning/error） */
export function dotState(state: 'ok' | 'bad' | 'neutral'): StateDotState {
  return state === 'ok' ? 'done' : state === 'bad' ? 'error' : 'warning'
}

export function StatusBadge({ state, children }: {
  state: 'ok' | 'bad' | 'neutral'
  children: ReactNode
}) {
  return (
    <span className={badgeClass(state)}>
      <StateDot state={dotState(state)} size={8} className={css.scBadgeDot} />
      {children}
    </span>
  )
}
