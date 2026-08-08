export type CrashStage =
  | 'event.before-commit'
  | 'event.after-commit'
  | 'snapshot.before-commit'
  | 'snapshot.after-commit'
  | 'resource.before-commit'
  | 'resource.after-commit'
  | 'backup.after-partial'
  | 'backup.after-publish'

let hook: ((stage: CrashStage) => void) | null = null

export function invokeCrashHook(stage: CrashStage): void {
  hook?.(stage)
}

export const _crashTesting = Object.freeze({
  setHook(value: ((stage: CrashStage) => void) | null): void {
    hook = value
  }
})
