import React from 'react'

/** Kept independent of providers so it can render when the application root fails. */
export function RootErrorFallback({ error, onReload = () => window.location.reload() }: {
  error: Error
  onReload?: () => void
}): React.JSX.Element {
  return (
    <div style={{ minHeight: '100vh', background: '#111', color: '#f5f5f5', padding: '24px', fontFamily: 'Consolas, monospace' }}>
      <h2 style={{ marginTop: 0 }}>Renderer crashed</h2>
      <p style={{ color: '#bbb' }}>The packaged app hit a frontend error during startup.</p>
      <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{error.stack || error.message}</pre>
      <p>Reloading may cause unsaved changes to be lost.</p>
      <button type="button" onClick={onReload}>Reload app</button>
    </div>
  )
}
