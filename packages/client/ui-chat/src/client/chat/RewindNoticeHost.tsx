/** Frame-wide outcome feedback for historical prompt actions. */
import { Fragment } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RewindNoticeInjected } from './rewind.ts'

type Props = PropsRuntime<'shell.overlay'> & PropsLocale<'chat'> & InjectFace<RewindNoticeInjected>

/**
 * Keep the outcome toast mounted after a rewind removes its source bubble.
 * @param props - framework-bound notice state, dismissal, and localized copy.
 * @returns the current outcome toast, if any.
 */
export function RewindNoticeHost({ useRewind, dismissNotice, t }: Props) {
  const notice = useRewind(value => value.notice)
  return notice === null ? null : (
    <Fragment key={notice.seq}>
      <Toast text={t(notice.key)} onDone={dismissNotice} />
    </Fragment>
  )
}
