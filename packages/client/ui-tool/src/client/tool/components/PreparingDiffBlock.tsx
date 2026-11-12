import { useEffect, useMemo, useRef, useState } from 'react'
import { DiffBlock, type DiffBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { preparingDiffCard, preparingDiffProgress, type PreparingDiffSource } from '../models/diff-card-model.ts'

/** Shortest pause between two redraws of a streaming card. */
export const PREPARING_DIFF_INTERVAL_MS = 200

/**
 * Pause before the next redraw. Rebuilding the card is linear in the streamed
 * text, so beyond the minimum the pause grows by one millisecond per streamed
 * KiB, and a very large argument cannot keep the page busy.
 * @param progress - decoded characters streamed so far.
 * @returns the redraw interval in milliseconds.
 */
export function preparingDiffInterval(progress: number): number {
  return Math.max(PREPARING_DIFF_INTERVAL_MS, Math.ceil(progress / 1024))
}

/**
 * Hold a changing value back to at most one change per interval, delivering
 * the latest value when the interval ends.
 * @param value - the value read in this render.
 * @param intervalMs - minimum time between two delivered changes.
 * @returns the last delivered value.
 */
function useThrottled<T>(value: T, intervalMs: number): T {
  const [shown, setShown] = useState(value)
  const deliveredAt = useRef(Number.NEGATIVE_INFINITY)
  useEffect(() => {
    if (Object.is(value, shown)) return undefined
    const wait = Math.max(0, deliveredAt.current + intervalMs - performance.now())
    const timer = window.setTimeout(() => {
      deliveredAt.current = performance.now()
      setShown(value)
    }, wait)
    return () => { window.clearTimeout(timer) }
  }, [intervalMs, shown, value])
  return shown
}

/** Props of {@link PreparingDiffBlock}. */
export interface PreparingDiffBlockProps {
  /** The streaming call; a new object for every republished block. */
  source: PreparingDiffSource
  labels: DiffBlockLabels
  maxLines: number
  className?: string | undefined
}

/**
 * The diff card of a call whose arguments are still streaming, mounted only
 * while its row is expanded. Every republished block re-renders it; the card
 * is rebuilt at most once per {@link preparingDiffInterval}.
 * @param props - see {@link PreparingDiffBlockProps}.
 * @returns the streaming diff card, or nothing before a content field opens.
 */
export function PreparingDiffBlock({ source, labels, maxLines, className }: PreparingDiffBlockProps) {
  const progress = preparingDiffProgress(source)
  const shown = useThrottled(progress, preparingDiffInterval(progress))
  const { toolName, args } = source
  // `shown` is the redraw signal; the card reads the arguments as they are now.
  const card = useMemo(() => preparingDiffCard({ toolName, args }), [toolName, args, shown])
  if (card === null) return null
  return <DiffBlock {...card.card} labels={labels} maxLines={maxLines} className={className} />
}
