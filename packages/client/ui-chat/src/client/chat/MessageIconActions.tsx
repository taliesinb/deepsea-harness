// Shared IconActions chrome for user and assistant messages: copy
// live, optional branch wiring, and an optional date-aware clock.

import { useId, useState, type ReactNode } from 'react'
import {
  IconBranchOutlineRegular, IconCheckOutlineRegular, IconCopyOutlineRegular,
  IconEditOutlineRegular, IconRefreshOutlineRegular, IconTrashOutlineRegular, Tooltip, useClipboardCopy,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatMessageClock } from './message-chrome.ts'
import { useCalendarDay } from './use-calendar-day.ts'
import css from './MessageIconActions.module.css'

/** Destructive operation on one historical prompt. */
type RewindAction = 'edit' | 'replay' | 'delete'

export interface MessageIconActionsProps {
  /** Plain text the copy action writes. */
  text: string
  /** Unix epoch ms for the clock label; omitted for transient messages. */
  time?: number | undefined
  /** Clock before icons (user) or after (assistant). */
  clock: 'start' | 'end'
  /** Fork the session at this message; omission hides the branch action. */
  onBranch?: (() => void) | undefined
  /** The message is not a completed transcript tail, so branch stays visible but unavailable. */
  branchUnavailable?: boolean | undefined
  /** Parent layout class composed onto the actions row. */
  className?: string | undefined
  /**
   * Slot-rendered actions owned by independent plugins, placed between the
   * built-in copy and branch controls.
   */
  extraActions?: ReactNode
  /**
   * Icon-row Turn-usage trigger (the TurnUsagePanel pill), seated after the
   * branch control at the end of the icon cluster.
   */
  usageAction?: ReactNode
  /**
   * Destructive prompt actions, run after their inline confirmation; omitted
   * while the Session is busy. The returned Promise keeps the confirmation
   * disabled until the action settles.
   */
  onRewind?: ((action: RewindAction) => Promise<void>) | undefined
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

/**
 * Copy / branch (/ clock) IconActions row shared by user and assistant chrome.
 * @param props - Copy text, event time, clock side, branch callback, className.
 * @returns The actions row element.
 */
export function MessageIconActions({
  text, time, clock, onBranch, branchUnavailable = false, className,
  extraActions, usageAction, onRewind, t,
}: MessageIconActionsProps) {
  const day = useCalendarDay()
  const reasonId = useId()
  const { copied, onCopy } = useClipboardCopy(text)
  const [confirming, setConfirming] = useState<RewindAction | null>(null)
  const [running, setRunning] = useState(false)
  // A Session that turns busy withdraws an unanswered confirmation.
  if (onRewind === undefined && confirming !== null && !running) setConfirming(null)
  const confirm = (): void => {
    if (onRewind === undefined || confirming === null) return
    setRunning(true)
    void onRewind(confirming).finally(() => {
      setRunning(false)
      setConfirming(null)
    })
  }
  const clockEl = time === undefined ? null : (
    <span className={clock === 'start' ? css.timeStart : css.timeEnd}>
      {formatMessageClock(time, t, day)}
    </span>
  )
  return (
    <div className={className === undefined ? css.actions : `${css.actions} ${className}`} data-clock={clock}>
      {clock === 'start' && (confirming !== null
        ? (
          <span className={css.rewindConfirm} data-prompt-rewind-confirm={confirming}>
            <span>{t('message.rewind.warning')}</span>
            <button type="button" className={css.textButton} disabled={running} onClick={() => { setConfirming(null) }}>
              {t('message.rewind.cancel')}
            </button>
            <button type="button" className={css.textButton} data-danger="" disabled={running} onClick={confirm}>
              {t(`message.${confirming}`)}
            </button>
          </span>
        )
        : onRewind === undefined ? clockEl : (
          <span className={css.rewindStart}>
            <span className={css.rewindClock}>{clockEl}</span>
            <span className={css.rewindActions} data-prompt-rewind-actions>
              <Tooltip label={t('message.edit')} side="bottom">
                <button type="button" className={css.action} aria-label={t('message.edit')} onClick={() => { setConfirming('edit') }}>
                  <IconEditOutlineRegular />
                </button>
              </Tooltip>
              <Tooltip label={t('message.replay')} side="bottom">
                <button type="button" className={css.action} aria-label={t('message.replay')} onClick={() => { setConfirming('replay') }}>
                  <IconRefreshOutlineRegular />
                </button>
              </Tooltip>
              <Tooltip label={t('message.delete')} side="bottom">
                <button type="button" className={css.action} aria-label={t('message.delete')} onClick={() => { setConfirming('delete') }}>
                  <IconTrashOutlineRegular />
                </button>
              </Tooltip>
            </span>
          </span>
        ))}
      <Tooltip label={copied ? t('copied') : t('copy')} side="bottom">
        <button type="button" className={css.action} aria-label={copied ? t('copied') : t('copy')} onClick={onCopy}>
          {copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
        </button>
      </Tooltip>
      {extraActions}
      {onBranch !== undefined && (
        <Tooltip label={branchUnavailable ? t('message.branchUnavailable') : t('message.branch')} side="bottom" openOnClick={branchUnavailable}>
          {/* Native disabled buttons do not deliver the hover/focus events Tooltip needs. */}
          <button
            type="button"
            className={css.action}
            aria-label={t('message.branch')}
            aria-disabled={branchUnavailable || undefined}
            aria-describedby={branchUnavailable ? reasonId : undefined}
            data-unavailable={branchUnavailable || undefined}
            onClick={branchUnavailable ? undefined : onBranch}
          >
            <IconBranchOutlineRegular />
          </button>
        </Tooltip>
      )}
      {onBranch !== undefined && branchUnavailable && (
        <span id={reasonId} className={css.visuallyHidden}>{t('message.branchUnavailable')}</span>
      )}
      {clock === 'end'
        ? <span className={css.endInfo}>{usageAction}{clockEl}</span>
        : usageAction}
    </div>
  )
}
