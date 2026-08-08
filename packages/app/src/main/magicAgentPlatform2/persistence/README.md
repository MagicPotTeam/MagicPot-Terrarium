# MagicAgent Platform 2.0 Persistence (M1 Resources)

## Backup/restore security contract

The public barrel exports only `MagicAgentEventStore` and the high-level backup/restore API and types. `sqliteAdapter.ts` and `_internalCreateEventStoreBackup` are implementation details; tests may import them relatively, but production callers must not.

Backups and restores resolve all input paths before asynchronous work, reject symbolic/reparse parent chains and aliases, validate SQLite integrity/schema/history/resource chains, and publish with a same-filesystem hard link so an existing destination is never overwritten. Filesystems that cannot create hard links fail closed. A failed SQLite backup may leave its unowned, UUID-named partial file; this is deliberate because deleting a file whose identity was never captured would be unsafe.

Restore uses `${target}.restore-journal.json`, durable file/directory syncs, identity-guarded deletion, and keeps a rollback hard link after successful replacement. `restoreEventStoreBackup` automatically recovers a valid incomplete journal; `recoverEventStoreRestore` can also be called explicitly during startup. Never delete rollback files automatically without operator policy.

Schema v3 retains the exact v1 event and v2 snapshot schemas and adds STRICT `resources` and `resource_mutations` tables. Existing stores migrate transactionally v1→v2→v3; v3 migration records `migrated_to_v3_at` without replacing the v1→v2 `migrated_at`. New stores are created directly as v3.

`mutateResource` atomically applies optimistic create/update/soft-delete revisions, appends a new event through the same conflict/coverage path as ordinary appends, and records a canonical idempotency command/result audit row. Resource timestamps are monotonic: update/delete timestamps may equal, but never precede, the current `updatedAt`. Deletion leaves a permanent tombstone, so a `(kind,id)` can never be recreated. Resource reads are detached and deeply frozen. Artifact paths use strict POSIX-relative syntax; hashes, MIME types, sizes, approval status, forbidden inline-content/path keys, and JSON-safe plain-record state are validated at the persistence boundary.

`listResources` orders exactly by `(updatedAt, resourceKind, resourceId)` and paginates with the complete `after: { updatedAt, resourceKind, resourceId }` cursor. Callers form the next cursor from the last returned resource; timestamp-only pagination is intentionally unsupported because it can omit rows sharing a timestamp.

Every v3 open performs a full resource mutation-chain audit after schema, index, foreign-key, and metadata validation. The audit authenticates every mutation command/event/result, verifies revision, timestamp, delete, and state continuity, and requires each current resource row to equal its final mutation result. This is intentionally O(all resources + mutations); a future version may persist an authenticated checkpoint to avoid rescanning an unchanged prefix.

This module is not production-wired and migrates no user data. Backup/restore is a main-process API only; it has no IPC or Session integration.

## Initialization and file-safety guarantees

Opening an existing v1 database first performs a read-only identity/schema validation, then opens it read-write, verifies the `PRAGMA database_list` main file against the probed real path/device/inode, fully revalidates, and only then enables WAL. New or zero-byte databases are confirmed empty after the read-write open; WAL is enabled and verified before one `BEGIN IMMEDIATE` transaction creates all tables, indexes, IDs, and metadata. A schema transaction failure is rolled back, leaving the database at identity `0/0` with no user schema; WAL files may remain, but initialization is safe to retry. `synchronous=NORMAL` is applied only after schema creation succeeds.

File-backed stores require the database file system to report stable, non-zero `dev` and `ino` values. Identity snapshots use bigint filesystem stats and opening fails closed with `EventStoreOpenError` when either value is zero. Windows NTFS, macOS, and mainstream Linux file systems are expected to provide these values; other or virtual/network file systems must be verified before use.

Symbolic-link database paths are rejected. Node's `DatabaseSync` API does not expose a SQLite `O_NOFOLLOW` file handle, so an extremely narrow OS-level replacement race cannot be eliminated completely. Production database directories must therefore be private and writable only by the application account.

This directory isolates the synchronous Node.js `node:sqlite` API behind a small adapter. It is
permitted only in the Electron main process; renderer and preload code must not import it.

This M1 slice is not connected to production Session, Graph, or IPC paths and has no production
migration or backup integration. Existing files are first inspected with real filesystem APIs,
symlinks and non-regular files are rejected, and non-empty databases are fully validated through a
read-only connection before any read-write connection or persistent PRAGMA is attempted. The
identity and complete v1 schema are checked again after the read-write open to reduce path-replacement
races. File databases use WAL, STRICT tables, foreign keys, disabled extension loading, and an
untrusted schema. An unidentified non-empty SQLite file is always rejected before persistent PRAGMAs
or DDL are run.

Append batches are atomic and capped at 1,000 events. Because `DatabaseSync` blocks the main
thread, a future service integration must serialize access deliberately or move database work to a
dedicated worker; this module does not pretend to provide asynchronous I/O.

Callers own lifecycle policy. `close()` only closes the database and deliberately does not force a
checkpoint; lifecycle code may call `checkpoint('FULL')` or `checkpoint('TRUNCATE')` first when its
durability/shutdown policy requires that. Callers may use `getNodeSQLiteCapability()` for runtime
diagnostics.

## Path safety

File-backed stores reject a database file symlink and any existing symbolic link in the requested parent chain. On Windows, parent components whose `realpath` differs from their absolute path are also rejected to cover junctions/reparse points where Node exposes them indirectly. For a new file, the opened `PRAGMA database_list` main path must resolve to `realpath(parent) + basename(requested)`, and its file identity must match a fresh `lstat` snapshot of the requested path.

This is defense in depth rather than an atomic `O_NOFOLLOW` open: `node:sqlite` does not expose the database file descriptor/open flags, so a narrow residual TOCTOU race remains between filesystem checks and SQLite's open. Keep the database directory non-writable by untrusted processes.

## Backup and restore durability

`createBackup` checkpoints FULL, writes a unique partial file in the destination directory with `node:sqlite` backup, validates schema v3, integrity, foreign keys, events, snapshots, and complete resource mutation chains through an independent read-only connection, hashes the stable file, then atomically renames it without overwrite. Backup directories must be private and not writable by untrusted accounts.

`restoreEventStoreBackup` verifies and validates the source before copying, fsyncs and independently validates the destination partial, and rejects open targets plus any target `-wal`/`-shm` sidecars. Replacing a target first atomically renames it to a same-directory caller-supplied or generated rollback path; successful restores intentionally keep that rollback. A post-swap failure restores the rollback and never deletes the backup or rollback. File fsync is required; directory fsync is best-effort at the platform boundary, and Windows may not support it. All symlink/reparse-point caveats above still apply.

## Restore journal safety state machine

Restore uses a version-2, identity-guarded journal beside the target. Its durable stages are
`prepared`, `rollback-linking`, `rollback-linked`, `target-removing`, `target-removed`,
`target-linking`, `target-linked`, `verifying`, and `verified`. Each stage is written before and
after the corresponding destructive filesystem action. Journal creation is no-replace; updates
fsync a private temporary file, verify the owned journal identity immediately before replacement,
and fsync both the resulting journal and directory.

The backup may be in any absolute directory. The target, partial, rollback, and journal must share
a safe parent and all paths must be distinct/non-aliasing. Recovery strictly parses only the exact
version-2 shape, verifies identities and the backup hash, and treats observed file identity as
authoritative. Unknown identities, sidecars, malformed or version-1 journals, and unsafe paths
require manual recovery and preserve every file and the journal. Automatic recovery deletes only
identity-guarded partial/journal files, never the backup or rollback. A valid new target is committed;
an invalid new target is replaced from the retained rollback when available.

## Legacy assistant session import (M1)

`createLegacySessionImportPlan` reads version 1/2/3 `chat-sessions.json` through a private OS temporary copy and returns a frozen preview-only plan. It never writes the source and keeps the legacy JSON authoritative until an explicit future switch. `executeLegacySessionImportPlan` revalidates source identity/hash and atomically imports deterministic session, run, artifact-reference, and manifest resources. Legacy artifact resources use `storage: 'legacy-reference'` plus `legacyRef`; they deliberately do not invent managed hashes or paths. No production IPC is connected in M1.

`mutateResourcesBatch` accepts up to 1000 prevalidated commands in one write lock and `BEGIN IMMEDIATE` transaction. Exact whole-batch replay is read-only; mixed replay/new batches are rejected.

## M1 forced-termination boundaries

Internal-only crash hooks cover event, snapshot, and resource writes immediately before and after COMMIT, backup after validated partial creation and after durable publication, and restore after rollback-linking, target-removing, and target-linking filesystem actions. A pre-COMMIT termination is recovered by SQLite rollback; a post-COMMIT termination preserves committed data. Hook failures after COMMIT propagate without attempting ROLLBACK. Forced process tests run the bundled internal `crashWorker.ts` under Electron with `ELECTRON_RUN_AS_NODE=1`; neither the worker nor crash hooks are exported from the public barrel or connected to production. Write locks and instance leases use a two-second stale boundary so a killed process can be reclaimed on bounded retry.
