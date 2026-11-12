// @vitest-environment jsdom
import { memo } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { TurnDisclosureBinding, UseDisclosure } from '../src/client/contract/slots.ts'
import { bindDisclosure, useDisclosure } from '../src/client/chat/use-disclosure.ts'

afterEach(cleanup)

function Disclosure({ useDisclosure, label }: { useDisclosure: UseDisclosure; label: string }) {
  const { expanded, toggle } = useDisclosure()
  return <button aria-expanded={expanded} onClick={toggle}>{label}</button>
}

const Forward = memo(function Forward(props: { useDisclosure: UseDisclosure; label: string }) {
  return <Disclosure {...props} />
})

describe('injected disclosure state', () => {
  it('supports local explicit reveal and collapse without a reset source', () => {
    function Group({ label }: { label: string }) {
      const { expanded, setExpanded } = useDisclosure()
      return <>
        <output>{expanded ? label : 'Closed'}</output>
        <button onClick={() => { setExpanded(true) }}>Reveal</button>
        <button onClick={() => { setExpanded(false) }}>Collapse</button>
      </>
    }
    const view = render(<Group label="First" />)
    expect(view.getByText('Closed')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Reveal' }))
    expect(view.getByText('First')).toBeTruthy()
    view.rerender(<Group label="Updated" />)
    expect(view.getByText('Updated')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Collapse' }))
    expect(view.getByText('Closed')).toBeTruthy()
  })

  it('subscribes only where the forwarded Hook is called and releases those subscriptions', () => {
    const reset = createSnapshotStore(0)
    const release = vi.fn()
    const subscribe = vi.fn((listener: () => void) => {
      const off = reset.subscribe(listener)
      return () => { off(); release() }
    })
    const source: ObservableSnapshot<number> = {
      getSnapshot: () => reset.getSnapshot(),
      subscribe,
    }
    const useDisclosure = bindDisclosure(source)
    expect(subscribe).not.toHaveBeenCalled()
    const view = render(<Forward useDisclosure={useDisclosure} label="Details" />)
    expect(subscribe).toHaveBeenCalledTimes(1)
    const button = view.getByRole('button', { name: 'Details' })

    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    act(() => { reset.set(1) })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(view.getByRole('button', { name: 'Details' })).toBe(button)
    expect(subscribe).toHaveBeenCalledTimes(1)

    view.unmount()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('keeps each disclosure independent while resetting all consumers of the same source', () => {
    const reset = createSnapshotStore(0)
    const otherReset = createSnapshotStore(0)
    const useDisclosure = bindDisclosure(reset)
    const useOtherDisclosure = bindDisclosure(otherReset)
    const view = render(<>
      <Forward useDisclosure={useDisclosure} label="First" />
      <Forward useDisclosure={useDisclosure} label="Second" />
      <Forward useDisclosure={useOtherDisclosure} label="Other Turn" />
    </>)
    const first = view.getByRole('button', { name: 'First' })
    const second = view.getByRole('button', { name: 'Second' })
    const other = view.getByRole('button', { name: 'Other Turn' })
    fireEvent.click(first)
    expect(first.getAttribute('aria-expanded')).toBe('true')
    expect(second.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(second)
    fireEvent.click(other)

    act(() => { reset.set(1) })
    expect(first.getAttribute('aria-expanded')).toBe('false')
    expect(second.getAttribute('aria-expanded')).toBe('false')
    expect(other.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(first)
    expect(first.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(first)
    expect(first.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(second)
    act(() => { reset.set(2) })
    expect(second.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('default state and whole-Turn choices', () => {
  function Row({ useDisclosure: use, defaultOpen }: { useDisclosure: UseDisclosure; defaultOpen?: boolean }) {
    const { expanded, toggle } = use(defaultOpen)
    return <button aria-expanded={expanded} onClick={toggle}>Row</button>
  }

  it('shows the default until the reader toggles, and follows a changing default', () => {
    const view = render(<Row useDisclosure={useDisclosure} defaultOpen={false} />)
    const row = view.getByRole('button')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    view.rerender(<Row useDisclosure={useDisclosure} defaultOpen />)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('applies an Option-click to the Turn, and lets a newer choice override the reader\'s own toggle', () => {
    const applyToTurn = vi.fn()
    const turn = createSnapshotStore<TurnDisclosureBinding>({ choice: undefined, applyToTurn })
    const bound = bindDisclosure(createSnapshotStore(0), turn)
    const view = render(<Row useDisclosure={bound} />)
    const row = view.getByRole('button')
    fireEvent.click(row, { altKey: true })
    expect(applyToTurn).toHaveBeenCalledWith(true)
    expect(row.getAttribute('aria-expanded')).toBe('false')
    act(() => { turn.set({ choice: { open: true, generation: 1 }, applyToTurn }) })
    expect(row.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('false')
    act(() => { turn.set({ choice: { open: true, generation: 2 }, applyToTurn }) })
    expect(row.getAttribute('aria-expanded')).toBe('true')
  })

  it('toggles only itself on Option-click outside a Turn', () => {
    const view = render(<Row useDisclosure={bindDisclosure(createSnapshotStore(0))} />)
    const row = view.getByRole('button')
    fireEvent.click(row, { altKey: true })
    expect(row.getAttribute('aria-expanded')).toBe('true')
  })
})
