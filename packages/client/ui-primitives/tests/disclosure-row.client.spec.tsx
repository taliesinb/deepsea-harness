// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { DisclosureRow } from '../src/DisclosureRow.tsx'

afterEach(cleanup)

describe('DisclosureRow toggle events', () => {
  it.each([false, true])('passes Option (%s) from the leading button, the row, and the keyboard', (altKey) => {
    const onToggle = vi.fn()
    const leading = render(<DisclosureRow icon={null} title="Leading" open={false} expandable onToggle={onToggle} />)
    fireEvent.click(leading.getByRole('button', { name: 'Leading' }), { altKey })
    leading.unmount()
    const row = render(<DisclosureRow icon={null} title="Row" open={false} expandable expandOnRowClick onToggle={onToggle} />)
    fireEvent.click(row.getByRole('button'), { altKey })
    fireEvent.keyDown(row.getByRole('button'), { key: 'Enter', altKey })
    expect(onToggle.mock.calls.map(([event]) => (event as { altKey: boolean }).altKey)).toEqual([altKey, altKey, altKey])
  })
})
