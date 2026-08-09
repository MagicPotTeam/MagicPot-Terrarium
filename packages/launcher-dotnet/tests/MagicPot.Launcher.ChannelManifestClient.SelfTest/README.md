# ChannelManifestClient self-test

Run from the repository root:

```powershell
dotnet run --project packages/launcher-dotnet/tests/MagicPot.Launcher.ChannelManifestClient.SelfTest/MagicPot.Launcher.ChannelManifestClient.SelfTest.csproj
```

The launcher is Windows-only. The client retains a non-Windows `FileStream` fallback for library compatibility, but the security boundary tested here is Windows `CreateFileW` behavior.

State transactions use two coordination layers:

- A `Local\`-scope named mutex reduces same-session contention and supports cancellation-friendly waiting.
- The real cross-process and cross-session boundary is the exclusively opened `stateRoot/update.lock` file handle. Windows opens the fixed path with `OPEN_ALWAYS`, read/write access, no sharing, and `FILE_FLAG_OPEN_REPARSE_POINT`; the same handle is identity/type/link-count validated and retained for the complete transaction.

The self-test covers ordinary concurrent lock serialization, replacement of the bound root identity, and rejection of `update.lock` reparse points and multiple-hard-link files. The hardlink case is required. The symbolic-link case records `SKIP` when Windows policy or privileges prevent fixture creation. Link tests also verify that the outside target remains unchanged and is not left locked.
