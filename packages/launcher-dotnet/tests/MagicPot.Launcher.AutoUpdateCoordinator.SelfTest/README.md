# AutoUpdateCoordinator SelfTest

Windows-only end-to-end self-test scope for the internal auto-update coordinator.

The suite is intended to exercise packages produced in memory through the fake manifest transport and the real FakeApp smoke protocol. Required scenarios are: successful install/activation; already-active zero-download idempotence; rejection of a forged, unbound candidate before the up-to-date check without trusting its version; network unavailable; hash, ZIP, install-conflict, and smoke failures with stage classification; cross-release runtime selection; cancellation propagation; lease/package/partial cleanup; and auto-on-launch-only policy rejection. Auto update additionally requires a non-null caller-supplied verified active baseline and an independently secure, fully matching active selection: a null baseline or a pointer whose installed files no longer verify is rejected before artifact transport. Bootstrap/first installation is outside this coordinator.

The stale-activation race blocks artifact transport, commits a concurrent winner, then verifies the transaction fails at `activate` with `stale-activation`, does not launch smoke, and leaves the winner active. Final active verification is also fault-injected after activation: if the exact receipt pointer remains active, the coordinator CAS-rolls it back to the complete prior pointer and re-verifies the restored installed pair; if another pointer won concurrently, it is never overwritten and the result is `active-rollback-failed`. A confirmed rollback returns `active-verification-failed` at `verify-active`, reports the old version as active, and leaves no activation journal. The hash-mismatch case covers app-download failure with a successful runtime download, and the invalid-ZIP case covers app-prepare failure with a successful runtime prepare; both assert empty cleanup registries, no partial trees, and no remaining file occupancy from the successful sibling capability.

No production URL or compiled update configuration is used. Test configuration and trusted source values must remain local to this project.

Run from a Windows developer prompt:

```powershell
dotnet run --project packages/launcher-dotnet/tests/MagicPot.Launcher.AutoUpdateCoordinator.SelfTest/MagicPot.Launcher.AutoUpdateCoordinator.SelfTest.csproj -warnaserror
```
