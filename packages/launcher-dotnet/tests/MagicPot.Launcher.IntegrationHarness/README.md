# Launcher process integration harness

This is a package-free Windows/.NET 8 console harness. It builds a real `FakeApp.exe`, creates isolated launcher roots under `%TEMP%`, writes real app/runtime manifests with SHA-256 hashes and sizes, and launches the app through `LauncherEngine`.

Run from the repository root:

```powershell
dotnet run --project packages/launcher-dotnet/tests/MagicPot.Launcher.IntegrationHarness/MagicPot.Launcher.IntegrationHarness.csproj
```

The project reference builds `MagicPot.Launcher.FakeApp` first. FakeApp accepts `healthy`, `early-exit`, `no-confirm`, `no-confirm-child`, and `hang-with-child`; the child modes spawn a 30-second inherited worker and publish root/child PID files for containment assertions. Healthy modes implement the `.health-lock/update.lock` owner-token protocol and write a matching `lastHealthy` receipt. When the test-only `MAGICPOT_TEST_ENV_CAPTURE` is an absolute path, healthy atomically captures only update mode/status/channel/version and launch build/runtime, both before and after confirmation.

The original 19 process/update/rollback/recovery scenarios remain. Two additional real-process scenarios verify that a health timeout and a post-health installed-tree integrity violation both return within a fixed bound and leave neither the root nor inherited child PID alive. Integration 23 adds a forced `ContainmentId` collision/registry-failure scenario and verifies that both independently owned jobs still reach empty cleanup; differing PIDs do not participate in guardian identity. The suite also includes committed activation-journal recovery through `LocalActivationStore`. A concurrency scenario blocks an activation commit while it owns `.health-lock/update.lock`, starts `LauncherEngine`, and verifies that startup waits without deleting the in-flight journal; after commit completes, the launcher resolves and starts the new active build. Additional real-process auto-update scenarios verify that activation-reset health is re-read immediately before pending begins, an `installed` result without candidate activation safely launches the old active version with `failed`, a damaged candidate pointer is CAS-rolled back to the old pointer, and a concurrent valid winner is preserved and launched. State hard-link and reparse rejection remain covered by `MagicPot.Launcher.LocalSmokeActivation.SelfTest`. Captures assert that active and started build/runtime identities agree. Every fixture and capture file is under its isolated temporary root and is removed on disposal.

For manual Roslyn compilation, compile `MagicPot.Launcher.FakeApp/Program.cs` as a Windows x64 executable referencing the .NET 8 reference assemblies, then compile the harness together with/referencing all launcher sources required by `LauncherEngine`, `LauncherUpdateCheck`, and channel-manifest model types. Place the FakeApp host/output files below `MagicPot.Launcher.FakeApp/bin/...`; the harness discovers the newest `FakeApp.exe` there.
