// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { Modal } from '../src/Modal.tsx'

// Server markup keeps the inline style that jsdom's CSSOM drops (`min()`); the portal renders in place.
vi.mock('react-dom', async original => ({ ...await original<typeof import('react-dom')>(), createPortal: (child: unknown) => child }))

it('sizes the dialog card from width, capped at the viewport, and leaves the stylesheet width otherwise', () => {
  expect(renderToStaticMarkup(<Modal open title="Wide" closeLabel="Close" onClose={() => {}} width={620} />))
    .toContain('style="width:min(620px, 100%)"')
  expect(renderToStaticMarkup(<Modal open title="Default" closeLabel="Close" onClose={() => {}} />))
    .not.toContain('style="width')
})
