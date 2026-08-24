import type { ComfyBatchProfile } from '@shared/api/svcComfyBatch'

let profiles: ComfyBatchProfile[] = []
let loaded = false
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((listener) => listener())
}

export function getComfyBatchProfileSnapshot(): ComfyBatchProfile[] {
  return profiles
}

export function setComfyBatchProfileSnapshot(next: ComfyBatchProfile[]): void {
  profiles = next
  loaded = true
  emit()
}

export function isComfyBatchProfileSnapshotLoaded(): boolean {
  return loaded
}

export function subscribeComfyBatchProfiles(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
