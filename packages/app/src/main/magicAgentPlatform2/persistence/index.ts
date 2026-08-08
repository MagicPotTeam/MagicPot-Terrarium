export { MagicAgentEventStore } from './eventStore'
export type {
  AppendResult,
  AppendSnapshotResult,
  CheckpointMode,
  CheckpointResult,
  RecoveryBundle,
  ResourceMutationInput,
  ResourceMutationResult,
  SnapshotInput,
  StoredResource,
  StoredSnapshot
} from './eventStore'
export {
  BackupError,
  HashMismatchError,
  recoverEventStoreRestore,
  RestoreError,
  restoreEventStoreBackup
} from './backupRestore'
export type { BackupManifest, RestoreEventStoreResult } from './backupRestore'
export {
  createLegacySessionImportPlan,
  executeLegacySessionImportPlan,
  LegacySessionImportFileTooLargeError,
  LegacySessionImportSourceChangedError,
  LegacySessionImportTooLargeError,
  LegacySessionImportValidationError,
  MAX_LEGACY_SESSION_IMPORT_BYTES,
  parseLegacySessionImportPlan
} from './legacySessionImport'
export type {
  LegacySessionImportCounts,
  LegacySessionImportEntry,
  LegacySessionImportPlan
} from './legacySessionImport'
