import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

interface Props {
  children: ReactNode
  label?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[prism] ${this.props.label ?? 'panel'} crashed:`, error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="empty selectable">
          <AlertTriangle size={22} className="rose" />
          <div className="title">{this.props.label ?? 'This panel'} hit an error</div>
          <pre className="mono small faint" style={{ whiteSpace: 'pre-wrap', maxWidth: 520, textAlign: 'left' }}>
            {String(this.state.error.stack ?? this.state.error.message)}
          </pre>
          <button className="btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
