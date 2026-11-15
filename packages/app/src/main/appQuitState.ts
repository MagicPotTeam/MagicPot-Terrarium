// packages/app/src/main/appQuitState.ts
// One process-wide fact: the user's quit has been confirmed and shutdown is running.
// Renderer recovery reads it so that a renderer which exits (or is terminated by the OS)
// during shutdown is never reloaded and never raises a recovery dialog.
let appQuitting = false

/** Call only after the quit can no longer be cancelled (confirmation passed, or an update install is closing the app). */
export function markAppQuitting(): void {
  appQuitting = true
}

export function isAppQuitting(): boolean {
  return appQuitting
}

// Windows only: the user is logging off or shutting the PC down. The OS then ends every process
// of the app; none of those exits is a death worth answering or recording.
let sessionEnding = false

export function markSessionEnding(): void {
  sessionEnding = true
}

export function isSessionEnding(): boolean {
  return sessionEnding
}

/** Test seam: the flags are terminal in production. */
export function resetAppQuittingForTests(): void {
  appQuitting = false
  sessionEnding = false
}
