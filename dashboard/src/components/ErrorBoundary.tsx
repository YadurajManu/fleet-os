import { Component, type ReactNode } from 'react'

/**
 * The last safety net, not the fix. A render that throws — a response shaped
 * unlike its type, a field that turned out optional — should cost you the
 * panel you were looking at, not the whole dashboard and its navigation.
 *
 * Reset it by changing `resetKey` (the route path): navigating away from a
 * page that threw gets you a working page rather than the same fallback.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: unknown },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="border-l-2 border-[var(--color-down)] bg-[color-mix(in_oklab,var(--color-down)_6%,transparent)] px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--color-down)]">
          this page hit an error
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
          {this.state.error.message || 'Something rendered wrong.'}
        </p>
        <button
          onClick={() => this.setState({ error: null })}
          className="mt-3 font-mono text-[10.5px] text-[var(--color-fg-dim)] underline transition-colors hover:text-[var(--color-fg)]"
        >
          try again
        </button>
      </div>
    )
  }
}
