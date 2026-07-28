# ArtifactPreparer SelfTest

Windows-only fail-closed extraction tests. In addition to ZIP/CRC/header/manifest coverage, the suite verifies the prepared result is a handle-pinned capability:

- a `PinnedAncestorChain` pins every existing segment from the volume root through `StateRoot` and the fixed `prepared` parent, creates missing segments one at a time, and rejects reparse/single-link/canonical-path changes;
- ancestor handles deny delete sharing for the complete prepare lease/package lifetime, so ancestor, prepared-parent, staging-root, and intermediate rename/replacement attempts fail;
- staging directory and file handles use exclusive sharing; an external `File.OpenRead` observer cannot attach during preparation or later block cleanup;
- `OpenRead(relative)` reads through same-process `DuplicateHandle` duplicates of the original pinned `GENERIC_READ|WRITE|DELETE` file handles rather than trusting a path; each duplicate is tracked until its wrapper is disposed (sync or async), exactly once;
- `Entries` is frozen from the internal pinned-file table; `TakeOwnership()` atomically transfers the complete tree, ancestor handles, and cleanup state exactly once under the same gate used by cleanup;
- after transfer the old lease has `OwnershipTransferred == true`, no tree or cleanup capability, rejects `OpenRead`, `RetryCleanup`, and repeated `TakeOwnership` with `InvalidOperationException`, and treats sync/async disposal as a no-op;
- transferred-lease `CleanupFailures` is an empty snapshot and `CleanupCompleted` is `false`: neither property exposes package state, and lease completion must not be mistaken for package cleanup completion;
- lease/package disposal first closes the capability to new readers and waits up to five seconds for active readers; timeout is non-throwing, records a bounded persistent `active readers` failure, retains all handles, and can be completed by the current owner with `RetryCleanup` after readers close;
- cleanup marks files delete-pending and removes each successful entry, then retries failed/nonempty directories deepest-first without recursively traversing a path; ancestor handles remain pinned until the entire staging tree is gone;
- package `CleanupCompleted` and snapshot `CleanupFailures` report its durable cleanup state after ownership transfer; concurrent transfer versus lease retry/disposal has exactly one winner and cannot double-clean the tree;
- create-before-pin race hooks cover both staging intermediates and newly-created state ancestors, replacing them with junctions and proving no file reaches the external target.

`Root` remains diagnostic only. A future installer must consume `Entries` and `OpenRead`; it must not treat the diagnostic path as installation authority.

Windows-only source-linked self-test for the inactive safe ZIP preparation layer.

It covers successful App/Runtime preparation, lease cleanup and one-shot ownership transfer, extension fail-closed behavior, traversal/absolute/backslash/device/empty-segment paths, case-insensitive duplicates, file-directory conflicts, Unix link/special modes, entry-count and exact unpacked-size budgets, manifest identity mismatch, file hash mismatch, missing entrypoint, and failed-staging cleanup. ZIP-specific adversarial coverage includes EOCD/central/local consistency, encrypted flags, local-vs-central method/CRC/compressed-size/uncompressed-size mismatches, and explicit streamed CRC32 verification.

Run with a .NET 8 SDK:

```powershell
dotnet run --project packages/launcher-dotnet/tests/MagicPot.Launcher.ArtifactPreparer.SelfTest/MagicPot.Launcher.ArtifactPreparer.SelfTest.csproj
```

The CRC corruption fixture flips a byte in a stored target entry while retaining the original local/central CRC, then rebuilds the signed artifact metadata (`sha256` and `size`) through `Fixture.App`. This proves `ArtifactDownloader` accepts the newly signed outer artifact while `ArtifactPreparer` rejects it using its own managed IEEE CRC32 (initial/final XOR `ffffffff`, polynomial `edb88320`) after a complete streamed extraction; it does not rely on `ZipArchive` CRC enforcement. CRC failures must leave the prepared staging directory empty. Post-extraction reparse/hard-link replacement remains a Windows adversarial concern; production checks every output handle for reparse status and link count.

Failure-path coverage also verifies that ancestor handles are released when stream seeking or safe unique-ID validation fails before a staging tree exists. Once a tree owns the ancestor chain, incomplete short cleanup produces an internal `ArtifactCleanupTicket`; both the caller retry and the process-wide background registry retain the pinned tree until cleanup completes, coordinate removal without double cleanup, and expose internal pending-count/pass hooks to this source-linked test only. Startup scanning/deletion of residual `.partial-*` paths is deliberately deferred: deleting by pathname without a persisted pinned identity would be unsafe.
