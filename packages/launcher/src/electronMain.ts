import { app } from 'electron'
import { runStableLauncher } from './main'

async function launch(): Promise<void> {
  try {
    await app.whenReady()
    await runStableLauncher()
    app.quit()
  } catch (error) {
    console.error('[Launcher] MagicPot could not be started:', error)
    app.exit(1)
  }
}

void launch()
