import { Component, type ErrorInfo, type ReactNode } from "react"

type Props = { children: ReactNode }
type State = { error: Error | null }

/**
 * The last thing between a thrown render and a white page.
 *
 * React unmounts the whole tree when nothing catches, which in a single-page
 * app means the window goes blank with no navigation, no message, and no way
 * back except knowing to reload. That is indistinguishable from the server
 * being down, so it gets reported as the server being down.
 *
 * It deliberately does not try to recover by re-rendering the same tree: the
 * state that caused the throw is still there, and a retry button that throws
 * again immediately is worse than one that reloads. Reload is offered instead,
 * along with a way back to the workspace for the common case — one screen is
 * broken and the rest of the app is fine.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept on the console rather than sent anywhere. There is no error
    // reporting service wired up, and inventing one here would mean shipping
    // whatever a stack trace happens to contain off the machine.
    console.error("[devpipe] render failed:", error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="gate">
        <div className="gate-card">
          <div className="brand">
            <span>Devpipe</span>
          </div>
          <p className="note bad">Something in the interface broke.</p>
          <p className="muted small">
            Your boxes and terminals are unaffected — they run on the box, not in this page, and anything in progress is
            still going.
          </p>
          <pre className="crash">{error.message || String(error)}</pre>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}
