import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

/** Top-level error boundary — prevents blank screen on uncaught render errors */
class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[AppErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '2rem', fontFamily: 'system-ui', color: '#e4e4e7', background: '#18181b', minHeight: '100vh' }}>
          <h1 style={{ color: '#f87171', marginBottom: '0.5rem' }}>Something went wrong</h1>
          <p style={{ color: '#a1a1aa', marginBottom: '1rem' }}>{this.state.error.message}</p>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload() }}
            style={{ padding: '0.5rem 1rem', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '0.375rem', cursor: 'pointer' }}
          >
            Reload
          </button>
          {import.meta.env.DEV && (
            <pre style={{ marginTop: '1rem', fontSize: '0.75rem', color: '#71717a', whiteSpace: 'pre-wrap', maxHeight: '300px', overflow: 'auto' }}>
              {this.state.error.stack}
            </pre>
          )}
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </AppErrorBoundary>
  </React.StrictMode>,
)
