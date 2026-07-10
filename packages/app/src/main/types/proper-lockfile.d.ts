declare module 'proper-lockfile' {
  export interface LockOptions {
    stale?: number
    update?: number
    realpath?: boolean
    retries?:
      | number
      | { retries?: number; factor?: number; minTimeout?: number; maxTimeout?: number }
  }

  export type ReleaseLock = () => Promise<void>

  export function lock(file: string, options?: LockOptions): Promise<ReleaseLock>
}
