# Local smoke activation self-test

Windows-only executable self-test for the signed download/prepare/install/direct-smoke/activation/recovery chain. Standalone activation uses the compatibility overload, which recovers the current pointer as `expectedFrom`; coordinator callers pass their previously resolved pointer explicitly. The transaction rechecks that exact pointer before smoke and uses it again for the commit CAS.

The activation-state coverage includes the `SafeAtomicWrite` temporary-file TOCTOU boundary:

- the launcher root and every ancestor are held by validated, non-delete-sharing directory handles for the full transaction scope;
- the temporary file is created with read/write/delete access and delete sharing only, so path writes and `File.OpenWrite` remain denied while the transaction handle is open;
- bytes are written, flushed, length-checked, fixed-time compared, and identity-checked through that same handle;
- publication uses `SetFileInformationByHandle(FileRenameInfo)` on the open temporary handle with `RootDirectory = NULL` and the target's absolute DOS path; no source pathname is used by the rename;
- the native buffer uses the Windows `FILE_RENAME_INFO` layout (name offset 20 on x64, 12 on x86), `ReplaceIfExists = 1`, a UTF-16 byte length that excludes the terminator, and a zero-filled trailing UTF-16 NUL; local micro-tests showed that the trailing NUL is required and that a relative `RootDirectory` returns Win32 error 87 on this Windows host;
- the target is restricted to the three fixed direct-child state files, safely reopened after rename, and required to have the temporary object's identity and exact expected bytes before schema parsing;
- if an attacker renames the temporary pathname and creates a replacement there, handle rename still publishes the original object while the replacement remains at the old temporary pathname and never affects the target;
- failed unpublished writes are made delete-pending through the original handle only; successful publication performs no old-path cleanup, so unknown replacements are never deleted;
- suspicious existing reparse points and multi-link files are rejected before replacement, while regular targets are replaced.

Run with warnings as errors:

```powershell
dotnet run --project packages/launcher-dotnet/tests/MagicPot.Launcher.LocalSmokeActivation.SelfTest/MagicPot.Launcher.LocalSmokeActivation.SelfTest.csproj -c Release -warnaserror
```

A successful run reports **162 or more assertions**, including normal create, replace, and rename-temp/create-replacement publication through the same Windows open-handle rename path: the original handle object reaches the expected target, while the replacement at the former temporary path is preserved and is not deleted. A native rename failure is reported by the self-test; there is no `MoveFileEx` or source-path fallback.
