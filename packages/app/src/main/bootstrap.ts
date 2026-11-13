import { app } from 'electron'
import { startHtmlChildRuntime } from './api/agentThreadHtmlChild'

// Keep the HTML helper process out of normal application initialization, profile,
// preload registration, configuration, model credentials and IPC handlers.
if (process.argv.includes('--magicpot-isolated-html-child')) {
  try { startHtmlChildRuntime() } catch { app.exit(1) }
} else {
  void import('./index').catch((error) => { console.error('Application bootstrap failed:', error); app.exit(1) })
}
