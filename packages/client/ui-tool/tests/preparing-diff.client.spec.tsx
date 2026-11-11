// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import type { StartedToolCall } from '@deepseek-ai/dsh-client-ui-chat/client'
import { contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { en as common } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { FileMutationRow } from '../src/client/tool/toolviews/file-mutation-row.tsx'
import {
  PREPARING_DIFF_INTERVAL_MS, preparingDiffInterval,
} from '../src/client/tool/components/PreparingDiffBlock.tsx'
import { preparingDiffCard, preparingDiffSource } from '../src/client/tool/models/diff-card-model.ts'

type Props = Parameters<typeof FileMutationRow>[0]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function preparation(name: string, args: PartialArguments): Extract<Props, { phase: 'preparing' }> {
  return {
    useContextMenu: contextMenuHook(), resolveFilePath: (path: string) => path,
    phase: 'preparing', callId: 'call', toolName: name,
    block: { phase: 'preparing', args, callId: 'call', name, turn: 1, step: 1, time: 1, subCalls: [] },
    cwd: '/workspace', t: makeTranslate(en, common), useDisclosure, openFile: vi.fn(), loadImage: vi.fn(),
  } as Extract<Props, { phase: 'preparing' }>
}

/** Republish the growing view as the Definition does after an observed answer changes. */
function republish(view: ReturnType<typeof render>, props: Extract<Props, { phase: 'preparing' }>): void {
  view.rerender(<FileMutationRow {...props} block={{ ...props.block }} />)
}

function card(view: ReturnType<typeof render>): string | null | undefined {
  return view.container.querySelector('[data-diff]')?.textContent
}

describe('streaming file-mutation preview', () => {
  it('shows a write\'s content so far while its arguments stream, redrawn at most once per interval', () => {
    const args = new PartialArguments()
    args.append('{"file_path":"/workspace/poem.txt","content":"first line')
    const props = preparation('write', args)
    const view = render(<FileMutationRow {...props} />)
    expect(view.container.querySelector('[data-state="preparing"]')).not.toBeNull()
    expect(card(view)).toBeUndefined()

    // The path of a file not written yet expands the row instead of opening it.
    fireEvent.click(view.getByText('poem.txt'))
    expect(props.openFile).not.toHaveBeenCalled()
    expect(card(view)).toContain('/workspace/poem.txt')
    expect(card(view)).toContain('first line')

    args.append('\\nsecond line')
    expect(args.refresh()).toBe(true)
    republish(view, props)
    act(() => { vi.advanceTimersByTime(0) })
    expect(card(view)).toContain('second line')

    args.append('\\nthird line')
    args.refresh()
    republish(view, props)
    act(() => { vi.advanceTimersByTime(PREPARING_DIFF_INTERVAL_MS - 1) })
    expect(card(view)).not.toContain('third line')
    args.append('\\nfourth line')
    args.refresh()
    republish(view, props)
    act(() => { vi.advanceTimersByTime(1) })
    expect(card(view)).toContain('fourth line')

    // Collapsing stops reading; reopening shows the arguments as they are now.
    fireEvent.click(view.getAllByText('poem.txt')[0]!)
    expect(card(view)).toBeUndefined()
    args.append('\\nfifth line')
    republish(view, props)
    fireEvent.click(view.getByText('poem.txt'))
    expect(card(view)).toContain('fifth line')
  })

  it('keeps the dispatched write card and its file link once the call starts', () => {
    const argsRaw = '{"file_path":"/workspace/poem.txt","content":"one\\ntwo"}'
    const args = new PartialArguments()
    args.append(argsRaw.slice(0, -2))
    const props = preparation('write', args)
    const view = render(<FileMutationRow {...props} />)
    fireEvent.click(view.getByText('poem.txt'))
    expect(card(view)).toContain('one')
    const started: StartedToolCall = {
      phase: 'start', args: args.settle(argsRaw), callId: 'call', name: 'write', turn: 1, step: 1, time: 2, subCalls: [], argsRaw,
    }
    view.rerender(<FileMutationRow {...props} phase="start" block={started} />)
    expect(card(view)).toContain('two')
    fireEvent.click(view.getAllByText('poem.txt')[0]!)
    expect(props.openFile).toHaveBeenCalledWith('/workspace/poem.txt')
  })

  it('keeps an edit\'s file link and expands its streaming diff from the row', () => {
    const args = new PartialArguments()
    args.append('{"file_path":"/workspace/a.ts","old_string":"const a = 1","new_string":"const a')
    const props = preparation('edit', args)
    const view = render(<FileMutationRow {...props} />)
    fireEvent.click(view.getByRole('button', { name: 'a.ts' }))
    expect(props.openFile).toHaveBeenCalledWith('/workspace/a.ts')
    expect(card(view)).toBeUndefined()
    fireEvent.click(view.getByText('Edit'))
    expect(card(view)).toContain('const a = 1')
  })

  it('folds a very large streaming content to the card\'s head and tail rows', () => {
    const lines = Array.from({ length: 40_000 }, (_, index) => `line ${index}`)
    const args = PartialArguments.fromText(JSON.stringify({ file_path: '/workspace/big.txt', content: lines.join('\n') }))
    const props = preparation('write', args)
    const view = render(<FileMutationRow {...props} />)
    fireEvent.click(view.getByText('big.txt'))
    const body = view.container.querySelector('[data-diff]')!
    expect(body.textContent).toContain('line 0')
    expect(body.textContent).toContain('line 39999')
    expect(body.textContent).not.toContain('line 20000')
    expect(preparingDiffInterval(lines.join('\n').length)).toBeGreaterThan(PREPARING_DIFF_INTERVAL_MS)
  })

  it('draws nothing before a content field opens or for a non-string path', () => {
    const waiting = PartialArguments.fromText('{"file_path":"/workspace/a.ts"}')
    expect(preparingDiffCard(preparingDiffSource('write', waiting)!)).toBeNull()
    expect(preparingDiffCard(preparingDiffSource('edit', waiting)!)).toBeNull()
    expect(preparingDiffCard(preparingDiffSource('write', PartialArguments.fromText('{"file_path":7,"content":"x"}'))!)).toBeNull()
    expect(preparingDiffSource('apply_patch', waiting)).toBeNull()
    expect(preparingDiffSource('write', PartialArguments.fromText('{"content":"x"}'))).toBeNull()

    const view = render(<FileMutationRow {...preparation('write', waiting)} />)
    fireEvent.click(view.getByText('a.ts'))
    expect(card(view)).toBeUndefined()
  })

  it('reads an edit that only adds text as a diff without removed lines', () => {
    const args = PartialArguments.fromText('{"file_path":"/workspace/a.ts","new_string":"added"}')
    expect(preparingDiffCard(preparingDiffSource('edit', args)!)).toEqual({
      card: { diffs: [{ path: '/workspace/a.ts', oldText: null, newText: 'added' }] },
    })
    const removal = PartialArguments.fromText('{"file_path":"/workspace/a.ts","old_string":"gone"}')
    expect(preparingDiffCard(preparingDiffSource('edit', removal)!)).toEqual({
      card: { diffs: [{ path: '/workspace/a.ts', oldText: 'gone', newText: '' }] },
    })
  })
})
