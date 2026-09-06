/** @jsxRuntime automatic @jsxImportSource react */
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from '../src/components/ErrorBoundary.tsx'

function mount(el: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(el))
  return {
    text: () => host.textContent ?? '',
    rerender: (next: React.ReactElement) => act(() => root.render(next)),
    unmount: () => { act(() => root.unmount()); host.remove() },
  }
}

const Boom = ({ bang }: { bang: boolean }) => {
  if (bang) throw new TypeError("Cannot read properties of undefined (reading 'length')")
  return <span>page ok</span>
}

test('a throwing child is contained; siblings outside the boundary survive', () => {
  let view!: ReturnType<typeof mount>
  assert.doesNotThrow(() => {
    view = mount(
      <div>
        <nav>nav</nav>
        <ErrorBoundary resetKey="/services/x">
          <Boom bang />
        </ErrorBoundary>
      </div>,
    )
  })
  assert.ok(view.text().includes('nav'), 'nav still rendered')
  assert.ok(view.text().includes('this page hit an error'), 'fallback shown')
  view.unmount()
})

test('changing resetKey (a route change) clears the fallback', () => {
  const view = mount(
    <ErrorBoundary resetKey="/a">
      <Boom bang />
    </ErrorBoundary>,
  )
  assert.ok(view.text().includes('this page hit an error'))

  view.rerender(
    <ErrorBoundary resetKey="/b">
      <Boom bang={false} />
    </ErrorBoundary>,
  )
  assert.equal(view.text(), 'page ok')
  view.unmount()
})
