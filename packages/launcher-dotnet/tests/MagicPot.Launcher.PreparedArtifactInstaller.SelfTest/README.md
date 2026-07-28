# PreparedArtifactInstaller self-test

Windows-only end-to-end self-test for signed download, preparation, and fail-closed installation.

Publication uses the measured close-move-repin model. Before publish, the installer captures the root FileID, every relative directory FileID, every file FileID/length/SHA-256, and the exact file/directory path sets. It then closes every partial-tree handle, marks the tree detached so path cleanup is forbidden, performs `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` without replacement, and immediately opens/pins the complete final tree. The post-move verifier compares the final tree to the snapshot. Any mismatch returns no receipt, closes verifier handles, preserves the orphan final, and emits a security diagnostic.

The `afterMoveBeforeReopen` attack hook runs before the final verifier opens. Covered attacks include:

- delete/rename then same-byte recreation after move (different FileID, fail closed);
- delete/rename then different-byte recreation after move (fail closed);
- a write in the hook (it may succeed while handles are closed, but post-move identity/hash validation rejects it);
- normal close-move-repin publication (succeeds);
- equivalent pre-move partial replacement (validation fails closed);
- preservation of an attacker-modified final tree after post-move verification failure.

`InstallAsync` returns an `InstalledArtifactReceipt` activation-path lease for both new and idempotent installs. The receipt pins the root and every declared directory with the read/attribute access needed for verification and `FileShare.Read` only (no share-write or share-delete), and pins every declared file with `GENERIC_READ` and `FileShare.Read`. Windows sharing rules therefore deny rename/delete of each pinned directory object and write/delete/replace of each existing pinned file, while ordinary `File.OpenRead` remains compatible.

The receipt fixes the identity and content of every declared object and prevents replacement of those objects while it is held. This is not an ACL and does **not** prevent another same-permission process from creating undeclared child files or directories. `ValidateForActivation()` (and the coordinator-named equivalent `ValidateImmediatelyBeforeLaunch()`) re-enumerates the exact tree and rechecks root/directory/file identities, file lengths, and SHA-256 hashes, so any undeclared child causes validation to fail; after that child is removed, validation succeeds again.

The activation coordinator must enforce all of these boundaries:

- call `ValidateImmediatelyBeforeLaunch()` immediately adjacent to `CreateProcess`, with no `await`, callback, hook, or other attacker-controlled work between validation and process creation;
- apply Windows DLL-search hardening rather than relying on the receipt to control undeclared DLL placement;
- ensure the entrypoint and every declared launch-critical file are included in and pinned by the receipt;
- retain the receipt through startup/smoke testing until health is confirmed, not merely until process creation succeeds.

The installer mutex/file lock may be released when `InstallAsync` returns: the receipt, not the installer lock, is the activation boundary. Disposing the receipt only closes lease handles and never deletes the final tree; existing-file writes and renames are allowed again. Do not retain only `FinalPath` or dispose early.

The self-test exercises fresh and idempotent receipts. Root/child-directory rename-delete and existing-file write-delete-replace must be denied; `File.OpenRead` must succeed. Creating an extra file and directory must succeed where the filesystem permits, exact-tree launch validation must then reject the change, deleting the extras must restore successful validation, and disposal must restore existing-file write and rename access.

If the move fails and the partial name remains, the installer reopens and compares it with the captured snapshot before permitting handle-based cleanup. A mismatch is fail-closed and preserves the unknown partial for cleanup-ticket/diagnostic handling. Existing conflicts are never deleted.

Run on Windows:

```powershell
dotnet run --project packages/launcher-dotnet/tests/MagicPot.Launcher.PreparedArtifactInstaller.SelfTest/MagicPot.Launcher.PreparedArtifactInstaller.SelfTest.csproj -warnaserror
```
