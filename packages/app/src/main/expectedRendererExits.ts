// packages/app/src/main/expectedRendererExits.ts
// A renderer exit the app itself is about to cause (today: the forced end of a hung renderer
// that the user chose to reload). The window's recovery code announces it here before it ends
// the process; the death recorder takes it, so the line in process-events.jsonl says that this
// exit was the user's reload and not a crash. An announcement nobody takes expires by itself.
import { performance } from 'node:perf_hooks'

export type ExpectedRendererExit = 'reload-after-hang'

const expectedExits = new Map<number, { tag: ExpectedRendererExit; until: number }>()

export function expectRendererExit(
  webContentsId: number,
  tag: ExpectedRendererExit,
  ttlMs: number,
  now: number = performance.now()
): void {
  if (!Number.isSafeInteger(webContentsId)) return
  expectedExits.set(webContentsId, { tag, until: now + ttlMs })
}

/** Returns the announcement for this renderer once (and only while it is still valid). */
export function takeExpectedRendererExit(
  webContentsId: number,
  now: number = performance.now()
): ExpectedRendererExit | undefined {
  const expected = expectedExits.get(webContentsId)
  if (!expected) return undefined
  expectedExits.delete(webContentsId)
  return now <= expected.until ? expected.tag : undefined
}

export function cancelExpectedRendererExit(webContentsId: number): void {
  expectedExits.delete(webContentsId)
}

export function resetExpectedRendererExitsForTests(): void {
  expectedExits.clear()
}
