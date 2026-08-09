using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MagicPot.Launcher;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

internal static class Program
{
    private const string Channel = "stable";
    private const string KeyId = "smoke-selftest-key";
    private const string CreatedAt = "2025-01-02T03:04:05.000Z";
    private const string Commit = "0123456789abcdef0123456789abcdef01234567";
    private const string Build = "20250102-030405-0123456";
    private const string OldBuild = "20250101-030405-0123456";
    private const string Runtime = "python-3.11.9-smoke-selftest";
    private const string Version = "1.2.3";
    private const string Origin = "https://smoke-selftest.invalid";
    private static readonly byte[] PrivateKey = Convert.FromHexString("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F");
    private static int assertions;

    public static async Task<int> Main()
    {
        if (!OperatingSystem.IsWindows()) { Console.WriteLine("SKIP: Windows-only local smoke activation self-test."); return 0; }
        string root = Path.Combine(Path.GetTempPath(), "MagicPot-SmokeActivation-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            ApiShape();
            AbsoluteDosHandleRename(root);
            await BoundedReader().ConfigureAwait(false);
            string fakeApp = await GetFakeAppDirectoryAsync(root).ConfigureAwait(false);
            await using Chain chain = await Chain.CreateAsync(Path.Combine(root, "chain"), fakeApp).ConfigureAwait(false);
            await SuccessAndNoOp(chain, root).ConfigureAwait(false);
            await NoOpRecoversPendingCommit(chain, root).ConfigureAwait(false);
            await SmokeFailureMatrix(chain, root).ConfigureAwait(false);
            await ChildHoldsPipeTimeout(chain, root).ConfigureAwait(false);
            await ReceiptValidation(chain, root).ConfigureAwait(false);
            await ReceiptAncestorLease(chain, root).ConfigureAwait(false);
            await StaleSmokeConcurrency(chain, root).ConfigureAwait(false);
            RecoveryAndWriteFailure(root);
            RepairInvalidCurrent(root);
            ActivationStatePathSafety(root);
            SafeAtomicWriteRaces(root);
            SafeDeleteRaces(root);
            StaleSourceActivation(root);
            TemporaryTreeRace(root);
            Console.WriteLine($"PASS: signed download/prepare/install/direct-smoke/activation/recovery chain; {assertions} assertions.");
            return 0;
        }
        finally { TryDelete(root); }
    }

    private static void ApiShape()
    {
        Need(typeof(LocalSmokeActivationTransaction).IsNotPublic, "transaction internal");
        MethodInfo[] execute = typeof(LocalSmokeActivationTransaction).GetMethods(BindingFlags.Instance | BindingFlags.NonPublic).Where(static method => method.Name == "Execute").ToArray();
        Need(execute.Any(static method => method.GetParameters().Select(static p => p.ParameterType).SequenceEqual(new[] { typeof(InstalledArtifactReceipt), typeof(InstalledArtifactReceipt) })), "standalone receipt overload retained");
        Need(execute.Any(static method => method.GetParameters().Select(static p => p.ParameterType).SequenceEqual(new[] { typeof(InstalledArtifactReceipt), typeof(InstalledArtifactReceipt), typeof(ActivePointerV1) })), "expectedFrom receipt overload exposed");
        Need(new LocalSmokeActivationOptions().Timeout == TimeSpan.FromSeconds(60), "default timeout");
        WindowsDllSearchHardening.EnsureInitialized();
        Need(WindowsDllSearchHardening.IsInitialized, "DLL hardening initialized");
    }

    private static void AbsoluteDosHandleRename(string parent)
    {
        string root = NewRoot(parent, "root-handle-rename"); LauncherLayout layout = LauncherLayout.Create(root);
        ActivePointerV1 first = Pointer(OldBuild, Runtime, null); ActivePointerV1 replacement = Pointer(Build, Runtime, first);
        using var scope = new ActivationStateTransactionScope(layout);
        scope.SafeAtomicWrite(layout.ActivePointer, first, Protocol.ParseActivePointer);
        Need(Protocol.ParseActivePointer(File.ReadAllText(layout.ActivePointer)).ActiveBuildId == OldBuild, "absolute DOS handle rename publishes new state");
        scope.SafeAtomicWrite(layout.ActivePointer, replacement, Protocol.ParseActivePointer);
        Need(Protocol.ParseActivePointer(File.ReadAllText(layout.ActivePointer)).ActiveBuildId == Build, "absolute DOS handle rename replaces existing state");

        string temp = Path.Combine(root, ".rename-attack.tmp");
        using var handle = InstallNative.CreateFileW(temp, InstallNative.GenericRead | InstallNative.GenericWrite | InstallNative.Delete, FileShare.Delete, IntPtr.Zero, FileMode.CreateNew, InstallNative.Normal | InstallNative.OpenReparse, IntPtr.Zero);
        Need(!handle.IsInvalid, "rename attack fixture handle created");
        MethodInfo rename = typeof(ActivationStateTransactionScope).GetMethod("HandleRenameToStatePath", BindingFlags.Instance | BindingFlags.NonPublic) ?? throw new InvalidOperationException("HandleRenameToStatePath missing");
        foreach (string attack in new[] { Path.Combine(parent, "active.json"), Path.Combine(root, "nested", "active.json") })
        {
            try { rename.Invoke(scope, new object[] { handle, attack }); }
            catch (TargetInvocationException error) when (error.InnerException is InvalidOperationException) { assertions++; continue; }
            throw new InvalidOperationException("Expected direct-root rename attack rejection: " + attack);
        }
        Need(string.Equals(InstallNative.Canonical(handle), InstallNative.Normalize(temp), StringComparison.OrdinalIgnoreCase), "rejected rename attacks leave source handle at its original path");
    }

    private static async Task BoundedReader()
    {
        BoundedOutput exact = await DirectSmokeLauncher.ReadBoundedAsync(new MemoryStream(Encoding.UTF8.GetBytes("abcd")), 4, CancellationToken.None).ConfigureAwait(false);
        Need(exact.Text == "abcd" && !exact.Exceeded, "exact bounded output accepted");
        BoundedOutput exceeded = await DirectSmokeLauncher.ReadBoundedAsync(new MemoryStream(Encoding.UTF8.GetBytes("abcdef")), 4, CancellationToken.None).ConfigureAwait(false);
        Need(exceeded.Text.Length == 0 && exceeded.Exceeded, "bounded output reports excess without decoding a truncated sequence");
        await ThrowsAsync<LocalSmokeActivationException>(async () => await DirectSmokeLauncher.ReadBoundedAsync(new MemoryStream(new byte[] { 0xC3, 0x28 }), 4, CancellationToken.None).ConfigureAwait(false), "invalid UTF-8 rejected").ConfigureAwait(false);
    }

    private static async Task SuccessAndNoOp(Chain chain, string parent)
    {
        string root = NewRoot(parent, "success");
        LauncherLayout layout = LauncherLayout.Create(root);
        AtomicJson.Write(layout.ActivePointer, Pointer(OldBuild, Runtime, null));
        AtomicJson.Write(layout.Health, new LauncherHealthStateV1(1, 7));
        using InstalledArtifactReceipt app = await Installer(root).InstallAsync(chain.App).ConfigureAwait(false);
        using InstalledArtifactReceipt runtime = await Installer(root).InstallAsync(chain.Runtime).ConfigureAwait(false);
        Need(File.Exists(Path.Combine(app.FinalPath, "FakeApp.exe")), "real FakeApp.exe installed");
        ActivationReceipt result = new LocalSmokeActivationTransaction(layout).Execute(app, runtime);
        Need(!result.NoOp && result.Previous?.ActiveBuildId == OldBuild, "previous pointer returned");
        Need(result.Current.ActiveBuildId == Build && result.Current.ActiveRuntimeId == Runtime, "target activated");
        Need(result.Current.PreviousBuildId == OldBuild && result.Current.PreviousRuntimeId == Runtime, "previous identity persisted");
        Need(result.Smoke is not null && result.Smoke.Version == Version && result.Smoke.BuildId == Build && result.Smoke.ExitCode == 0, "smoke info matches");
        Need(LocalActivationStore.ReadCurrent(layout)?.ActiveBuildId == Build, "active file switched");
        Need(Protocol.ParseHealth(File.ReadAllText(layout.Health)).FailedAttemptCount == 0, "health reset");
        Need(!File.Exists(layout.ActivationJournal), "journal deleted");
        Need(!Directory.EnumerateFileSystemEntries(Path.Combine(root, "smoke-state")).Any(), "temporary root cleaned");

        var counter = new CountingLauncher();
        ActivationReceipt noOp = new LocalSmokeActivationTransaction(layout, new LocalSmokeActivationOptions { ProcessLauncher = counter }).Execute(app, runtime);
        Need(noOp.NoOp && noOp.Smoke is null && counter.Count == 0, "same target does not launch smoke");
    }

    private static async Task NoOpRecoversPendingCommit(Chain chain, string parent)
    {
        string root = NewRoot(parent, "noop-recovery");
        LauncherLayout layout = LauncherLayout.Create(root);
        ActivePointerV1 from = Pointer(OldBuild, Runtime, null); ActivePointerV1 to = Pointer(Build, Runtime, from);
        AtomicJson.Write(layout.ActivePointer, to); AtomicJson.Write(layout.Health, new LauncherHealthStateV1(1, 9)); WriteJournal(layout, from, to);
        using InstalledArtifactReceipt app = await Installer(root).InstallAsync(chain.App).ConfigureAwait(false);
        using InstalledArtifactReceipt runtime = await Installer(root).InstallAsync(chain.Runtime).ConfigureAwait(false);
        var counter = new CountingLauncher();
        ActivationReceipt result = new LocalSmokeActivationTransaction(layout, new LocalSmokeActivationOptions { ProcessLauncher = counter }).Execute(app, runtime);
        Need(result.NoOp && counter.Count == 0, "same target recovery completes before no-op without smoke");
        Need(Protocol.ParseHealth(File.ReadAllText(layout.Health)).FailedAttemptCount == 0, "same target recovery clears health");
        Need(!File.Exists(layout.ActivationJournal), "same target recovery deletes journal");
    }

    private static async Task SmokeFailureMatrix(Chain chain, string parent)
    {
        foreach ((string mode, TimeSpan timeout) in new[]
        {
            ("nonzero", TimeSpan.FromSeconds(3)), ("hang", TimeSpan.FromMilliseconds(150)),
            ("malformed", TimeSpan.FromSeconds(3)), ("mismatch", TimeSpan.FromSeconds(3)),
            ("oversize", TimeSpan.FromSeconds(5)), ("stderr-oversize", TimeSpan.FromSeconds(5)),
            ("invalid-utf8", TimeSpan.FromSeconds(3))
        })
        {
            string root = NewRoot(parent, "failure-" + mode);
            LauncherLayout layout = LauncherLayout.Create(root);
            ActivePointerV1 from = Pointer(OldBuild, Runtime, null);
            AtomicJson.Write(layout.ActivePointer, from);
            using InstalledArtifactReceipt app = await Installer(root).InstallAsync(chain.App).ConfigureAwait(false);
            using InstalledArtifactReceipt runtime = await Installer(root).InstallAsync(chain.Runtime).ConfigureAwait(false);
            WithEnvironment("MAGICPOT_TEST_SMOKE_MODE", mode, () => Throws<LocalSmokeActivationException>(() => new LocalSmokeActivationTransaction(layout, new LocalSmokeActivationOptions { Timeout = timeout }).Execute(app, runtime), mode + " rejected"));
            Need(LocalActivationStore.ReadCurrent(layout)?.ActiveBuildId == OldBuild, mode + " leaves active unchanged");
            Need(!File.Exists(layout.ActivationJournal), mode + " leaves no journal");
        }

        string logsRoot = NewRoot(parent, "extra-output");
        LauncherLayout logsLayout = LauncherLayout.Create(logsRoot);
        AtomicJson.Write(logsLayout.ActivePointer, Pointer(OldBuild, Runtime, null));
        using InstalledArtifactReceipt logsApp = await Installer(logsRoot).InstallAsync(chain.App).ConfigureAwait(false);
        using InstalledArtifactReceipt logsRuntime = await Installer(logsRoot).InstallAsync(chain.Runtime).ConfigureAwait(false);
        ActivationReceipt logsResult = WithEnvironment("MAGICPOT_TEST_SMOKE_MODE", "extra-output", () => new LocalSmokeActivationTransaction(logsLayout).Execute(logsApp, logsRuntime));
        Need(logsResult.Smoke?.StandardOutput.Contains("fake app diagnostic", StringComparison.Ordinal) == true, "preceding logs allowed");
    }

    private static async Task ChildHoldsPipeTimeout(Chain chain, string parent)
    {
        string root = NewRoot(parent, "child-holds-pipe");
        LauncherLayout layout = LauncherLayout.Create(root);
        AtomicJson.Write(layout.ActivePointer, Pointer(OldBuild, Runtime, null));
        AtomicJson.Write(layout.Health, new LauncherHealthStateV1(1, 11));
        string activeBefore = File.ReadAllText(layout.ActivePointer); string healthBefore = File.ReadAllText(layout.Health);
        using InstalledArtifactReceipt app = await Installer(root).InstallAsync(chain.App).ConfigureAwait(false);
        using InstalledArtifactReceipt runtime = await Installer(root).InstallAsync(chain.Runtime).ConfigureAwait(false);
        string pidPath = Path.Combine(parent, "pipe-child.pid");
        var elapsed = Stopwatch.StartNew();
        try
        {
            WithEnvironment("MAGICPOT_TEST_CHILD_PID_PATH", pidPath, () => WithEnvironment("MAGICPOT_TEST_SMOKE_MODE", "child-holds-pipe", () => Throws<LocalSmokeActivationException>(() => new LocalSmokeActivationTransaction(layout, new LocalSmokeActivationOptions { Timeout = TimeSpan.FromMilliseconds(150), HardTerminationTimeout = TimeSpan.FromMilliseconds(500) }).Execute(app, runtime), "pipe-holding process tree is bounded")));
        }
        finally { KillRecordedProcess(pidPath); }
        elapsed.Stop();
        Need(elapsed.Elapsed < TimeSpan.FromSeconds(3), "pipe-holding timeout returns within total deadline");
        Need(File.ReadAllText(layout.ActivePointer) == activeBefore, "pipe-holding timeout leaves active byte-for-byte unchanged");
        Need(File.ReadAllText(layout.Health) == healthBefore, "pipe-holding timeout leaves health byte-for-byte unchanged");
        Need(!File.Exists(layout.ActivationJournal), "pipe-holding timeout leaves no journal");
        Need(!File.Exists(pidPath), "pipe-holding child is cleaned up");
    }

    private static async Task ReceiptValidation(Chain chain, string parent)
    {
        string root = NewRoot(parent, "receipts");
        LauncherLayout layout = LauncherLayout.Create(root);
        using InstalledArtifactReceipt app = await Installer(root).InstallAsync(chain.App).ConfigureAwait(false);
        using InstalledArtifactReceipt runtime = await Installer(root).InstallAsync(chain.Runtime).ConfigureAwait(false);
        InstalledAppManifestV1 manifest = (InstalledAppManifestV1)app.Manifest;
        SetAutoProperty(manifest, "RuntimeId", "wrong-runtime");
        try { Throws<LocalSmokeActivationException>(() => new LocalSmokeActivationTransaction(layout).Execute(app, runtime), "app/runtime mismatch rejected"); }
        finally { SetAutoProperty(manifest, "RuntimeId", Runtime); }
        Need(!File.Exists(layout.ActivePointer) && !File.Exists(layout.ActivationJournal), "mismatch writes no activation state");

        string extra = Path.Combine(app.FinalPath, "attacker-extra.txt");
        File.WriteAllText(extra, "extra");
        Throws<PreparedArtifactInstallationException>(() => app.ValidateImmediatelyBeforeLaunch(), "receipt rejects extra file");
        File.Delete(extra);
        app.ValidateImmediatelyBeforeLaunch();
    }

    private static async Task ReceiptAncestorLease(Chain chain, string parent)
    {
        string wrapper = NewRoot(parent, "receipt-lease-wrapper");
        string root = NewRoot(wrapper, "launcher");
        LauncherLayout layout = LauncherLayout.Create(root);
        InstalledArtifactReceipt? app = null; InstalledArtifactReceipt? runtime = null;
        try
        {
            app = await Installer(root).InstallAsync(chain.App).ConfigureAwait(false);
            runtime = await Installer(root).InstallAsync(chain.Runtime).ConfigureAwait(false);
            AssertMoveDenied(root, root + "-moved", "launcher root pinned while receipts live");
            AssertMoveDenied(layout.Apps, layout.Apps + "-moved", "apps container pinned while receipt lives");
            AssertMoveDenied(layout.Runtimes, layout.Runtimes + "-moved", "runtimes container pinned while receipt lives");
            AssertMoveDenied(app.FinalPath, app.FinalPath + "-moved", "app final pinned while receipt lives");
            AssertMoveDenied(runtime.FinalPath, runtime.FinalPath + "-moved", "runtime final pinned while receipt lives");
            app.ValidateImmediatelyBeforeLaunch(); runtime.ValidateImmediatelyBeforeLaunch();
            Need(true, "both receipts remain valid after denied ancestor renames");
        }
        finally { app?.Dispose(); runtime?.Dispose(); }
        Need(app is not null && runtime is not null, "both installed receipts reached disposal");

        MoveAndRestore(layout.Apps, "apps container rename succeeds after receipt disposal");
        MoveAndRestore(root, "launcher root rename succeeds after receipt disposal");
    }

    private static async Task StaleSmokeConcurrency(Chain chain, string parent)
    {
        string root = NewRoot(parent, "stale-smoke"); LauncherLayout layout = LauncherLayout.Create(root);
        ActivePointerV1 from = Pointer(OldBuild, Runtime, null); ActivePointerV1 winner = Pointer("20250103-030303-ccccccc", Runtime, from);
        AtomicJson.Write(layout.ActivePointer, from); AtomicJson.Write(layout.Health, new LauncherHealthStateV1(1, 8));
        using InstalledArtifactReceipt app = await Installer(root).InstallAsync(chain.App).ConfigureAwait(false);
        using InstalledArtifactReceipt runtime = await Installer(root).InstallAsync(chain.Runtime).ConfigureAwait(false);
        var launcher = new BlockingLauncher();
        Task<Exception?> transaction = Task.Run(() => { try { new LocalSmokeActivationTransaction(layout, new LocalSmokeActivationOptions { ProcessLauncher = launcher }).Execute(app, runtime); return null; } catch (Exception error) { return error; } });
        Need(launcher.Entered.Wait(TimeSpan.FromSeconds(5)), "smoke launcher blocked after reading from");
        LocalActivationStore.Commit(layout, from, winner, DateTimeOffset.Parse("2025-01-02T03:04:06Z"));
        launcher.Release.Set(); Exception? error = await transaction.ConfigureAwait(false);
        Need(error is LocalSmokeActivationException, "stale smoke transaction rejected");
        Need(LocalActivationStore.ReadCurrent(layout)?.ActiveBuildId == winner.ActiveBuildId, "concurrent winner remains active");
        Need(!File.Exists(layout.ActivationJournal), "stale smoke leaves no journal");
    }

    private static void StaleSourceActivation(string parent)
    {
        string root = NewRoot(parent, "stale-source"); LauncherLayout layout = LauncherLayout.Create(root);
        const string buildA = "20250101-010101-aaaaaaa";
        const string buildC = "20250103-030303-ccccccc";
        const string buildD = "20250104-040404-ddddddd";
        ActivePointerV1 a = Pointer(buildA, Runtime, null);
        ActivePointerV1 c = Pointer(buildC, Runtime, a);
        ActivePointerV1 d = Pointer(buildD, Runtime, a);
        AtomicJson.Write(layout.ActivePointer, a); AtomicJson.Write(layout.Health, new LauncherHealthStateV1(1, 13));
        LocalActivationStore.Commit(layout, a, c, DateTimeOffset.Parse("2025-01-02T03:04:06Z"));
        Need(LocalActivationStore.ReadCurrent(layout)?.ActiveBuildId == buildC, "fresh A to C commit succeeds");
        string active = File.ReadAllText(layout.ActivePointer); string health = File.ReadAllText(layout.Health);
        string? journal = File.Exists(layout.ActivationJournal) ? File.ReadAllText(layout.ActivationJournal) : null;
        Throws<LocalSmokeActivationException>(() => LocalActivationStore.Commit(layout, a, d, DateTimeOffset.Parse("2025-01-02T03:04:07Z")), "stale A to D commit rejected");
        Need(File.ReadAllText(layout.ActivePointer) == active && LocalActivationStore.ReadCurrent(layout)?.ActiveBuildId == buildC, "stale commit preserves active C");
        Need(File.ReadAllText(layout.Health) == health, "stale commit preserves health");
        Need(journal is null ? !File.Exists(layout.ActivationJournal) : File.ReadAllText(layout.ActivationJournal) == journal, "stale commit leaves journal absent or unchanged");
    }

    private static void RecoveryAndWriteFailure(string parent)
    {
        string root = NewRoot(parent, "recovery-to"); LauncherLayout layout = LauncherLayout.Create(root);
        ActivePointerV1 from = Pointer(OldBuild, Runtime, null); ActivePointerV1 to = Pointer(Build, Runtime, from);
        AtomicJson.Write(layout.ActivePointer, to); AtomicJson.Write(layout.Health, new LauncherHealthStateV1(1, 9)); WriteJournal(layout, from, to);
        LocalActivationStore.Recover(layout);
        Need(LocalActivationStore.ReadCurrent(layout)?.ActiveBuildId == Build && Protocol.ParseHealth(File.ReadAllText(layout.Health)).FailedAttemptCount == 0 && !File.Exists(layout.ActivationJournal), "recover committed resets health and deletes journal");

        root = NewRoot(parent, "recovery-from"); layout = LauncherLayout.Create(root);
        AtomicJson.Write(layout.ActivePointer, from); AtomicJson.Write(layout.Health, new LauncherHealthStateV1(1, 4)); WriteJournal(layout, from, to);
        LocalActivationStore.Recover(layout);
        Need(LocalActivationStore.ReadCurrent(layout)?.ActiveBuildId == OldBuild && Protocol.ParseHealth(File.ReadAllText(layout.Health)).FailedAttemptCount == 4 && !File.Exists(layout.ActivationJournal), "recover aborted only deletes journal");

        root = NewRoot(parent, "recovery-inconsistent"); layout = LauncherLayout.Create(root);
        AtomicJson.Write(layout.ActivePointer, Pointer("other-build", Runtime, null)); WriteJournal(layout, from, to);
        ThrowsWithInner<LocalSmokeActivationException>(() => LocalActivationStore.Recover(layout), "inconsistent recovery fails closed");
        Need(File.Exists(layout.ActivePointer) && File.Exists(layout.ActivationJournal), "inconsistent active and journal preserved");

        root = NewRoot(parent, "recovery-invalid-active"); layout = LauncherLayout.Create(root);
        File.WriteAllText(layout.ActivePointer, "{invalid-active"); WriteJournal(layout, from, to);
        ThrowsWithInner<LocalSmokeActivationException>(() => LocalActivationStore.Recover(layout), "invalid active fails closed");
        Need(File.Exists(layout.ActivePointer) && File.Exists(layout.ActivationJournal), "invalid active and journal preserved");

        root = NewRoot(parent, "recovery-invalid-journal"); layout = LauncherLayout.Create(root);
        AtomicJson.Write(layout.ActivePointer, from); File.WriteAllText(layout.ActivationJournal, "{invalid-journal");
        ThrowsWithInner<LocalSmokeActivationException>(() => LocalActivationStore.Recover(layout), "invalid journal fails closed");
        Need(File.Exists(layout.ActivePointer) && File.Exists(layout.ActivationJournal), "active and invalid journal preserved");

        root = NewRoot(parent, "activation-write-failure"); layout = LauncherLayout.Create(root);
        AtomicJson.Write(layout.ActivePointer, from); Directory.CreateDirectory(layout.ActivationJournal);
        ThrowsWithInner<LocalSmokeActivationException>(() => LocalActivationStore.Commit(layout, from, to, DateTimeOffset.Parse("2025-01-02T03:04:05Z")), "journal write failure");
        Need(LocalActivationStore.ReadCurrent(layout)?.ActiveBuildId == OldBuild && Directory.Exists(layout.ActivationJournal), "write failure leaves from and blocking object");
    }

    private static void RepairInvalidCurrent(string parent)
    {
        ActivePointerV1 target = Pointer(Build, Runtime, null);
        foreach (string kind in new[] { "missing", "damaged" })
        {
            LauncherLayout layout = LauncherLayout.Create(NewRoot(parent, "repair-" + kind));
            AtomicJson.Write(layout.Health, new LauncherHealthStateV1(1, 7));
            if (kind == "damaged") File.WriteAllText(layout.ActivePointer, "{ damaged");
            LocalActivationStore.RepairInvalidCurrent(layout, target);
            Need(LocalActivationStore.ReadCurrent(layout)?.ActiveBuildId == Build, kind + " active repaired");
            Need(Protocol.ParseHealth(File.ReadAllText(layout.Health)).FailedAttemptCount == 0, kind + " repair resets health");
            Need(!File.Exists(layout.ActivationJournal), kind + " repair leaves no journal");
        }

        LauncherLayout stale = LauncherLayout.Create(NewRoot(parent, "repair-stale"));
        ActivePointerV1 winner = Pointer(OldBuild, Runtime, null);
        AtomicJson.Write(stale.ActivePointer, winner);
        Throws<LocalSmokeActivationException>(() => LocalActivationStore.RepairInvalidCurrent(stale, target), "repair rejects concurrent valid owner");
        Need(LocalActivationStore.ReadCurrent(stale)?.ActiveBuildId == OldBuild, "repair preserves concurrent valid owner");

        LauncherLayout same = LauncherLayout.Create(NewRoot(parent, "repair-same"));
        AtomicJson.Write(same.ActivePointer, target);
        AtomicJson.Write(same.Health, new LauncherHealthStateV1(1, 9));
        LocalActivationStore.RepairInvalidCurrent(same, target);
        Need(Protocol.ParseHealth(File.ReadAllText(same.Health)).FailedAttemptCount == 0, "same repair resets health");
    }

    private static void ActivationStatePathSafety(string parent)
    {
        ActivationScopePinsPaths(parent);
        foreach (string stateName in new[] { "active.json", "activation-journal.json", "launcher-health.json" })
        {
            StateHardLinkRejected(parent, stateName);
            StateSymbolicLinkRejectedOrSkipped(parent, stateName);
        }
        UpdateLockLinkRejected(parent, symbolic: false);
        UpdateLockLinkRejected(parent, symbolic: true);
        AttackerTemporaryFilesIgnored(parent);
    }

    private static void ActivationScopePinsPaths(string parent)
    {
        string root = NewRoot(parent, "state-scope-pins"); LauncherLayout layout = LauncherLayout.Create(root);
        AtomicJson.Write(layout.ActivePointer, Pointer(OldBuild, Runtime, null));
        using (var scope = new ActivationStateTransactionScope(layout))
        {
            Need(scope.SafeReadJson(layout.ActivePointer, Protocol.ParseActivePointer)?.ActiveBuildId == OldBuild, "scope reads valid active state");
            AssertMoveDenied(root, root + "-moved", "activation scope pins launcher root");
            AssertMoveDenied(layout.HealthLock, layout.HealthLock + "-moved", "activation scope pins health-lock directory");
        }
        MoveAndRestore(layout.HealthLock, "health-lock rename succeeds after scope disposal");
        MoveAndRestore(root, "activation root rename succeeds after scope disposal");
    }

    private static void StateHardLinkRejected(string parent, string stateName)
    {
        string root = NewRoot(parent, "state-hardlink-" + stateName.Replace('.', '-')); LauncherLayout layout = LauncherLayout.Create(root);
        string state = StatePath(layout, stateName); string target = Path.Combine(parent, "outside-hardlink-" + stateName.Replace('.', '-') + "-" + Guid.NewGuid().ToString("N"));
        string content = StateContent(stateName); File.WriteAllText(state, content); Need(File.Exists(state), stateName + " legitimate state seeded before substitution"); File.Delete(state); File.WriteAllText(target, content);
        Need(CreateHardLinkW(state, target, IntPtr.Zero), stateName + " hard link created after deleting legitimate state");
        Need(File.Exists(state) && File.ReadAllText(state) == content, stateName + " hard link initially aliases external target");
        Throws<LocalSmokeActivationException>(() => { if (stateName == "active.json") LocalActivationStore.RepairInvalidCurrent(layout, Pointer(Build, Runtime, null)); else ExerciseState(layout, stateName); }, stateName + " hard link rejected");
        Need(File.Exists(state), stateName + " suspicious hard link is not deleted");
        Need(File.ReadAllText(state) == content, stateName + " suspicious hard link content unchanged");
        Need(File.Exists(target) && File.ReadAllText(target) == content, stateName + " external hard-link target byte content unchanged");
        File.WriteAllText(target, content + "-identity-check");
        Need(File.ReadAllText(state) == content + "-identity-check", stateName + " suspicious hard link was not replaced");
    }

    private static void StateSymbolicLinkRejectedOrSkipped(string parent, string stateName)
    {
        string root = NewRoot(parent, "state-symlink-" + stateName.Replace('.', '-')); LauncherLayout layout = LauncherLayout.Create(root);
        string state = StatePath(layout, stateName); string target = Path.Combine(parent, "outside-symlink-" + stateName.Replace('.', '-') + "-" + Guid.NewGuid().ToString("N"));
        string content = StateContent(stateName); File.WriteAllText(state, content); Need(File.Exists(state), stateName + " legitimate state seeded before symlink substitution"); File.Delete(state); File.WriteAllText(target, content);
        if (!CreateSymbolicLinkW(state, target, 0))
        {
            Console.WriteLine("SKIP: CreateSymbolicLinkW unavailable for " + stateName + "; Win32=" + Marshal.GetLastWin32Error());
            Need(File.ReadAllText(target) == content, stateName + " symlink-unavailable external target unchanged");
            return;
        }
        if (!IsReadableReparse(state))
        {
            Console.WriteLine("SKIP: symbolic-link fixture is not readable for " + stateName);
            Need(File.ReadAllText(target) == content, stateName + " unreadable symlink external target unchanged");
            return;
        }
        Throws<LocalSmokeActivationException>(() => { if (stateName == "active.json") LocalActivationStore.RepairInvalidCurrent(layout, Pointer(Build, Runtime, null)); else ExerciseState(layout, stateName); }, stateName + " symbolic link rejected");
        Need(File.Exists(state), stateName + " suspicious symbolic link is not deleted");
        Need(File.Exists(target) && File.ReadAllText(target) == content, stateName + " symbolic-link target byte content unchanged");
        Need((File.GetAttributes(state) & FileAttributes.ReparsePoint) != 0, stateName + " suspicious symbolic link was not replaced");
    }

    private static void UpdateLockLinkRejected(string parent, bool symbolic)
    {
        string kind = symbolic ? "symlink" : "hardlink"; string root = NewRoot(parent, "update-lock-" + kind); LauncherLayout layout = LauncherLayout.Create(root);
        Directory.CreateDirectory(layout.HealthLock); string lockPath = Path.Combine(layout.HealthLock, "update.lock");
        string target = Path.Combine(parent, "outside-update-lock-" + kind + "-" + Guid.NewGuid().ToString("N")); const string content = "outside-update-lock-content"; File.WriteAllText(target, content);
        bool created = symbolic ? CreateSymbolicLinkW(lockPath, target, 0) : CreateHardLinkW(lockPath, target, IntPtr.Zero);
        if (!created && symbolic)
        {
            Console.WriteLine("SKIP: CreateSymbolicLinkW unavailable for update.lock; Win32=" + Marshal.GetLastWin32Error());
            Need(File.ReadAllText(target) == content, "update.lock symlink-unavailable target unchanged"); return;
        }
        Need(created, "preexisting update.lock " + kind + " created");
        if (symbolic && !IsReadableReparse(lockPath))
        {
            Console.WriteLine("SKIP: update.lock symbolic-link fixture is not readable");
            Need(File.ReadAllText(target) == content, "unreadable update.lock symbolic-link target unchanged");
            return;
        }
        Throws<LocalSmokeActivationException>(() => LocalActivationStore.Commit(layout, null, Pointer(Build, Runtime, null), DateTimeOffset.Parse("2025-01-02T03:04:05Z")), "update.lock " + kind + " rejected");
        Need(File.Exists(lockPath), "suspicious update.lock " + kind + " remains present");
        Need(File.ReadAllText(target) == content, "update.lock " + kind + " external target unchanged");
        if (!symbolic)
        {
            File.WriteAllText(target, content + "-identity-check");
            Need(File.ReadAllText(lockPath) == content + "-identity-check", "update.lock hard link not replaced");
        }
    }

    private static void AttackerTemporaryFilesIgnored(string parent)
    {
        string root = NewRoot(parent, "attacker-temp-files"); LauncherLayout layout = LauncherLayout.Create(root);
        ActivePointerV1 from = Pointer(OldBuild, Runtime, null); ActivePointerV1 to = Pointer(Build, Runtime, from); AtomicJson.Write(layout.ActivePointer, from);
        var attackerFiles = new[] { Path.Combine(root, "active.json.tmp-attacker"), Path.Combine(root, ".active.json.tmp-attacker"), Path.Combine(root, ".activation-journal.json.tmp-attacker"), Path.Combine(root, ".launcher-health.json.tmp-attacker") };
        foreach (string path in attackerFiles) File.WriteAllText(path, "attacker-content-" + Path.GetFileName(path));
        LocalActivationStore.Commit(layout, from, to, DateTimeOffset.Parse("2025-01-02T03:04:05Z"));
        Need(LocalActivationStore.ReadCurrent(layout)?.ActiveBuildId == Build, "normal commit succeeds beside attacker temp files");
        Need(Protocol.ParseHealth(File.ReadAllText(layout.Health)).FailedAttemptCount == 0, "normal commit writes health beside attacker temp files");
        Need(!File.Exists(layout.ActivationJournal), "normal commit removes only its activation journal");
        foreach (string path in attackerFiles)
        {
            Need(File.Exists(path), Path.GetFileName(path) + " ignored and retained");
            Need(File.ReadAllText(path) == "attacker-content-" + Path.GetFileName(path), Path.GetFileName(path) + " never trusted or modified");
        }
        Need(!Directory.EnumerateFiles(root, ".*.tmp-*", SearchOption.TopDirectoryOnly).Except(attackerFiles, StringComparer.OrdinalIgnoreCase).Any(), "normal commit leaves no unique transaction temp file");
    }

    private static void SafeAtomicWriteRaces(string parent)
    {
        string root = NewRoot(parent, "safe-atomic-write-sharing"); LauncherLayout layout = LauncherLayout.Create(root);
        ActivePointerV1 from = Pointer(OldBuild, Runtime, null); ActivePointerV1 to = Pointer(Build, Runtime, from); AtomicJson.Write(layout.ActivePointer, from);
        int hooks = 0;
        ActivationStateTransactionScope.BeforeHandleRename = temp =>
        {
            hooks++;
            Throws<IOException>(() => File.WriteAllText(temp, "attacker"), "atomic temp File.WriteAllText sharing denied");
            Throws<IOException>(() => { using FileStream ignored = File.OpenWrite(temp); }, "atomic temp File.OpenWrite sharing denied");
        };
        try { LocalActivationStore.Commit(layout, from, to, DateTimeOffset.Parse("2025-01-02T03:04:05Z")); }
        finally { ActivationStateTransactionScope.BeforeHandleRename = null; }
        Need(hooks == 3, "normal commit holds each temporary handle through its move");
        Need(LocalActivationStore.ReadCurrent(layout)?.ActiveBuildId == Build, "normal commit succeeds with read/write sharing probes denied");
        Need(!File.Exists(layout.ActivationJournal), "normal commit deletes journal after atomic writes");
        Need(!File.Exists(Path.Combine(layout.HealthLock, "update.lock")), "normal commit removes shared owner lock");

        root = NewRoot(parent, "safe-atomic-write-rename"); layout = LauncherLayout.Create(root);
        from = Pointer(OldBuild, Runtime, null); to = Pointer(Build, Runtime, from); AtomicJson.Write(layout.ActivePointer, from);
        const string replacementMarker = "attacker replacement marker";
        string? attackedTemp = null; string? movedOriginal = null;
        ActivationStateTransactionScope.BeforeHandleRename = temp =>
        {
            if (attackedTemp is not null || !Path.GetFileName(temp).StartsWith("." + Path.GetFileName(layout.ActivePointer) + ".tmp-", StringComparison.OrdinalIgnoreCase)) return;
            attackedTemp = temp; movedOriginal = temp + ".attacker-moved";
            File.Move(temp, movedOriginal);
            File.WriteAllText(temp, replacementMarker);
            Throws<IOException>(() => { using FileStream ignored = File.OpenWrite(movedOriginal); }, "renamed original handle still denies File.OpenWrite");
        };
        try { LocalActivationStore.Commit(layout, from, to, DateTimeOffset.Parse("2025-01-02T03:04:05Z")); }
        finally { ActivationStateTransactionScope.BeforeHandleRename = null; }
        Need(LocalActivationStore.ReadCurrent(layout)?.ActiveBuildId == Build, "handle rename commits the original object at the expected active state target after its source path is renamed");
        Need(attackedTemp is not null && Path.GetFileName(attackedTemp).StartsWith("." + Path.GetFileName(layout.ActivePointer) + ".tmp-", StringComparison.OrdinalIgnoreCase), "rename race attacks the active pointer write whose expected target is active.json");
        Need(!File.Exists(layout.ActivationJournal), "committed journal is deleted normally");
        Need(attackedTemp is not null && File.Exists(attackedTemp) && File.ReadAllText(attackedTemp) == replacementMarker, "replacement at the old temp path is preserved and never published");
        Need(movedOriginal is not null && !File.Exists(movedOriginal), "original object moved from its attacker-selected name to the fixed target");
    }

    private static void SafeDeleteRaces(string parent)
    {
        string root = NewRoot(parent, "safe-delete-races"); LauncherLayout layout = LauncherLayout.Create(root);
        ActivePointerV1 from = Pointer(OldBuild, Runtime, null); ActivePointerV1 to = Pointer(Build, Runtime, from);
        AtomicJson.Write(layout.ActivePointer, to); AtomicJson.Write(layout.Health, new LauncherHealthStateV1(1, 9)); WriteJournal(layout, from, to);
        string moved = layout.ActivationJournal + ".moved"; string replacement = Protocol.Serialize(new ActivationJournalV1(1, "prepared", CreatedAt, to, Pointer("attacker-build", Runtime, to)));
        ActivationStateTransactionScope.BeforeDeleteDisposition = path =>
        {
            Need(string.Equals(path, layout.ActivationJournal, StringComparison.OrdinalIgnoreCase), "delete hook receives journal path");
            Exception? race = Task.Run(() =>
            {
                try { File.Move(path, moved); File.WriteAllText(path, replacement); return null; }
                catch (Exception error) { return error; }
            }).GetAwaiter().GetResult();
            Need(race is IOException or UnauthorizedAccessException, "journal rename and replacement is sharing denied while first handle pins name");
            Need(File.Exists(path) && !File.Exists(moved), "pinned journal name remains unchanged before disposition");
        };
        try { LocalActivationStore.Recover(layout); }
        finally { ActivationStateTransactionScope.BeforeDeleteDisposition = null; }
        Need(!File.Exists(layout.ActivationJournal) && !File.Exists(moved), "safe delete success leaves journal path absent");

        AtomicJson.Write(layout.ActivePointer, from); WriteJournal(layout, from, to);
        ActivationStateTransactionScope.AfterClose = path => File.WriteAllText(path, replacement);
        try { Throws<LocalSmokeActivationException>(() => LocalActivationStore.Recover(layout), "post-close replacement fails closed"); }
        finally { ActivationStateTransactionScope.AfterClose = null; }
        Need(File.Exists(layout.ActivationJournal), "post-close replacement is preserved");
        Need(File.ReadAllText(layout.ActivationJournal) == replacement, "post-close replacement is never deleted");
    }

    private static void ExerciseState(LauncherLayout layout, string stateName)
    {
        ActivePointerV1 from = Pointer(OldBuild, Runtime, null); ActivePointerV1 to = Pointer(Build, Runtime, from);
        if (stateName == "activation-journal.json") LocalActivationStore.Recover(layout);
        else LocalActivationStore.Commit(layout, stateName == "active.json" ? from : null, to, DateTimeOffset.Parse("2025-01-02T03:04:05Z"));
    }

    private static string StatePath(LauncherLayout layout, string stateName) => stateName switch { "active.json" => layout.ActivePointer, "activation-journal.json" => layout.ActivationJournal, "launcher-health.json" => layout.Health, _ => throw new ArgumentOutOfRangeException(nameof(stateName)) };
    private static string StateContent(string stateName) => stateName switch { "active.json" => Protocol.Serialize(Pointer(OldBuild, Runtime, null)), "activation-journal.json" => Protocol.Serialize(new ActivationJournalV1(1, "prepared", CreatedAt, Pointer(OldBuild, Runtime, null), Pointer(Build, Runtime, Pointer(OldBuild, Runtime, null)))), "launcher-health.json" => Protocol.Serialize(new LauncherHealthStateV1(1, 17)), _ => throw new ArgumentOutOfRangeException(nameof(stateName)) };

    private static bool IsReadableReparse(string path)
    {
        try { return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0; }
        catch (FileNotFoundException) { return false; }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLinkW(string fileName, string existingFileName, IntPtr securityAttributes);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateSymbolicLinkW(string symbolicLinkFileName, string targetFileName, uint flags);

    private static void TemporaryTreeRace(string parent)
    {
        string root = NewRoot(parent, "temp-race"); string smokeRoot = Path.Combine(root, "smoke-state"); Directory.CreateDirectory(smokeRoot);
        string path = Path.Combine(smokeRoot, Guid.NewGuid().ToString("N"));
        using (var chain = new InstallAncestorChain(root, "smoke-state"))
        {
            chain.CreateExclusive(path);
            using SmokeTemporaryTree tree = SmokeTemporaryTree.Open(path, chain, chain.CanonicalContainer);
            string electron = Path.Combine(path, "Electron", "Cache"); Directory.CreateDirectory(electron); File.WriteAllText(Path.Combine(electron, "data.bin"), "content");
            string moved = path + "-moved";
            Directory.Move(path, moved);
            Directory.CreateDirectory(path); File.WriteAllText(Path.Combine(path, "replacement.marker"), "preserve");
            tree.Cleanup();
            Need(!Directory.Exists(moved), "moved original beneath allowed root is cleaned by pinned identity");
            Need(File.Exists(Path.Combine(path, "replacement.marker")), "replacement temporary path is never deleted");
            Need(tree.CleanupPendingReason is null, "safe moved cleanup has no pending orphan");
        }

        path = Path.Combine(smokeRoot, Guid.NewGuid().ToString("N"));
        string outside = Path.Combine(root, "outside-moved");
        using (var chain = new InstallAncestorChain(root, "smoke-state"))
        {
            chain.CreateExclusive(path); File.WriteAllText(Path.Combine(path, "original.marker"), "preserve");
            using SmokeTemporaryTree tree = SmokeTemporaryTree.Open(path, chain, chain.CanonicalContainer);
            Directory.Move(path, outside);
            Directory.CreateDirectory(path); File.WriteAllText(Path.Combine(path, "replacement.marker"), "preserve");
            tree.Cleanup();
            Need(File.Exists(Path.Combine(outside, "original.marker")), "original moved outside allowed root is preserved");
            Need(File.Exists(Path.Combine(path, "replacement.marker")), "outside-move replacement is preserved");
            Need(tree.CleanupPendingReason is not null, "outside move records cleanup failure");
        }
    }

    private static void WriteJournal(LauncherLayout layout, ActivePointerV1? from, ActivePointerV1 to) => AtomicJson.Write(layout.ActivationJournal, new ActivationJournalV1(1, "prepared", CreatedAt, from, to));
    private static ActivePointerV1 Pointer(string build, string runtime, ActivePointerV1? previous) => new(1, build, runtime, previous?.ActiveBuildId, previous?.ActiveRuntimeId, CreatedAt);
    private static PreparedArtifactInstaller Installer(string root) => new(new PreparedArtifactInstallerOptions { Root = root, LockTimeout = TimeSpan.FromSeconds(10), LockRetryDelay = TimeSpan.FromMilliseconds(10) });
    private static string NewRoot(string parent, string name) { string path = Path.Combine(parent, name); Directory.CreateDirectory(path); return path; }
    private static void AssertMoveDenied(string source, string destination, string label)
    {
        try { Directory.Move(source, destination); if (Directory.Exists(destination)) Directory.Move(destination, source); }
        catch (IOException) { assertions++; return; }
        catch (UnauthorizedAccessException) { assertions++; return; }
        throw new InvalidOperationException("Expected sharing denial: " + label);
    }
    private static void MoveAndRestore(string path, string label)
    {
        string moved = path + "-moved"; Directory.Move(path, moved); Need(Directory.Exists(moved) && !Directory.Exists(path), label); Directory.Move(moved, path); Need(Directory.Exists(path) && !Directory.Exists(moved), label + " and restore succeeds");
    }
    private static void KillRecordedProcess(string pidPath)
    {
        try
        {
            if (!File.Exists(pidPath)) { Need(true, "pipe-holding child left no surviving pid marker"); return; }
            if (int.TryParse(File.ReadAllText(pidPath), out int pid))
            {
                try
                {
                    using Process process = Process.GetProcessById(pid);
                    if (!process.HasExited) process.Kill(entireProcessTree: true);
                    process.WaitForExit(1000);
                    Need(process.HasExited, "recorded pipe-holding child is no longer running");
                }
                catch (ArgumentException) { Need(true, "recorded pipe-holding child already exited"); }
            }
        }
        finally { try { File.Delete(pidPath); } catch { } }
    }

    private static async Task<string> GetFakeAppDirectoryAsync(string root)
    {
        string? supplied = Environment.GetEnvironmentVariable("MAGICPOT_FAKE_APP_DIR");
        if (!string.IsNullOrWhiteSpace(supplied)) { RequireFakeApp(supplied); return Path.GetFullPath(supplied); }
        string project = Path.Combine(root, "fake-app-build"); Directory.CreateDirectory(project);
        string source = Path.Combine(FindRepositoryRoot(AppContext.BaseDirectory) ?? throw new InvalidOperationException("Repository root not found; set MAGICPOT_FAKE_APP_DIR."), "packages", "launcher-dotnet", "tests", "MagicPot.Launcher.FakeApp", "Program.cs");
        File.Copy(source, Path.Combine(project, "Program.cs"));
        File.WriteAllText(Path.Combine(project, "FakeApp.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><AssemblyName>FakeApp</AssemblyName><DefineConstants>MAGICPOT_SMOKE_FAKE_APP</DefineConstants><TreatWarningsAsErrors>true</TreatWarningsAsErrors><Nullable>enable</Nullable></PropertyGroup></Project>");
        var start = new ProcessStartInfo("dotnet") { UseShellExecute = false, WorkingDirectory = project, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        start.ArgumentList.Add("build"); start.ArgumentList.Add("FakeApp.csproj"); start.ArgumentList.Add("-c"); start.ArgumentList.Add("Release"); start.ArgumentList.Add("--nologo");
        using Process process = Process.Start(start) ?? throw new InvalidOperationException("dotnet build did not start");
        string stdout = await process.StandardOutput.ReadToEndAsync().ConfigureAwait(false); string stderr = await process.StandardError.ReadToEndAsync().ConfigureAwait(false); await process.WaitForExitAsync().ConfigureAwait(false);
        if (process.ExitCode != 0) throw new InvalidOperationException("FakeApp build failed:\n" + stdout + stderr);
        string output = Path.Combine(project, "bin", "Release", "net8.0"); RequireFakeApp(output); return output;
    }

    private static void RequireFakeApp(string directory)
    {
        foreach (string file in new[] { "FakeApp.exe", "FakeApp.dll", "FakeApp.runtimeconfig.json" }) if (!File.Exists(Path.Combine(directory, file))) throw new InvalidOperationException("MAGICPOT_FAKE_APP_DIR is incomplete: " + file);
    }

    private static string? FindRepositoryRoot(string start) { DirectoryInfo? current = new(start); while (current is not null) { if (Directory.Exists(Path.Combine(current.FullName, "packages", "launcher-dotnet"))) return current.FullName; current = current.Parent; } return null; }
    private static void SetAutoProperty(object instance, string name, object? value) => (instance.GetType().GetField("<" + name + ">k__BackingField", BindingFlags.Instance | BindingFlags.NonPublic) ?? throw new InvalidOperationException("Backing field missing")).SetValue(instance, value);
    private static T WithEnvironment<T>(string name, string value, Func<T> action) { string? old = Environment.GetEnvironmentVariable(name); try { Environment.SetEnvironmentVariable(name, value); return action(); } finally { Environment.SetEnvironmentVariable(name, old); } }
    private static void WithEnvironment(string name, string value, Action action) => WithEnvironment(name, value, () => { action(); return 0; });
    private static void Throws<T>(Action action, string label) where T : Exception { try { action(); } catch (T) { assertions++; return; } throw new InvalidOperationException("Expected " + typeof(T).Name + ": " + label); }
    private static void ThrowsWithInner<T>(Action action, string label) where T : Exception { try { action(); } catch (T error) { Need(error.InnerException is not null, label + " retains inner exception"); return; } throw new InvalidOperationException("Expected " + typeof(T).Name + ": " + label); }
    private static async Task ThrowsAsync<T>(Func<Task> action, string label) where T : Exception { try { await action().ConfigureAwait(false); } catch (T) { assertions++; return; } throw new InvalidOperationException("Expected " + typeof(T).Name + ": " + label); }
    private static void Need(bool condition, string label) { assertions++; if (!condition) throw new InvalidOperationException("Self-test assertion failed: " + label); }
    private static void TryDelete(string path) { try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch { } }

    private sealed class CountingLauncher : IProcessLauncher
    {
        internal int Count { get; private set; }
        public SmokeProcessResult Launch(InstalledArtifactReceipt appReceipt, InstalledArtifactReceipt runtimeReceipt, SmokeProcessRequest request) { Count++; throw new InvalidOperationException("no-op launched process"); }
    }

    private sealed class BlockingLauncher : IProcessLauncher
    {
        internal ManualResetEventSlim Entered { get; } = new(false);
        internal ManualResetEventSlim Release { get; } = new(false);
        public SmokeProcessResult Launch(InstalledArtifactReceipt appReceipt, InstalledArtifactReceipt runtimeReceipt, SmokeProcessRequest request)
        {
            Entered.Set(); if (!Release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("blocking smoke test timed out");
            return new SmokeProcessResult(0, false, "{\"ok\":true,\"version\":\"" + Version + "\",\"buildId\":\"" + Build + "\"}\n", string.Empty, false, false);
        }
    }

    private sealed class FakeTransport : IChannelManifestTransport
    {
        private readonly IReadOnlyDictionary<string, byte[]> bodies;
        internal FakeTransport(IReadOnlyDictionary<string, byte[]> bodies) => this.bodies = bodies;
        public Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested(); Uri uri = request.RequestUri ?? throw new InvalidOperationException("missing URI");
            if (!bodies.TryGetValue(uri.AbsoluteUri, out byte[]? body)) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound) { RequestMessage = request });
            var response = new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = new HttpRequestMessage(request.Method, uri), Content = new ByteArrayContent(body) }; response.Content.Headers.ContentLength = body.Length; return Task.FromResult(response);
        }
        public void Dispose() { }
    }

    private sealed class Chain : IAsyncDisposable
    {
        private readonly ArtifactDownloader downloader; private readonly PreparedArtifactLease appLease; private readonly PreparedArtifactLease runtimeLease;
        private Chain(ArtifactDownloader downloader, VerifiedArtifactLease appDownload, VerifiedArtifactLease runtimeDownload, PreparedArtifactLease appLease, PreparedArtifactLease runtimeLease) { this.downloader = downloader; AppDownload = appDownload; RuntimeDownload = runtimeDownload; this.appLease = appLease; this.runtimeLease = runtimeLease; App = appLease.TakeOwnership(); Runtime = runtimeLease.TakeOwnership(); }
        internal VerifiedArtifactLease AppDownload { get; } internal VerifiedArtifactLease RuntimeDownload { get; } internal PreparedArtifactPackage App { get; } internal PreparedArtifactPackage Runtime { get; }
        internal static async Task<Chain> CreateAsync(string root, string fakeAppDirectory)
        {
            Directory.CreateDirectory(root); byte[] appZip = MakeAppZip(fakeAppDirectory); byte[] runtimeZip = MakeRuntimeZip();
            string appUrl = Origin + "/owner/repo/releases/download/v1/app.zip", runtimeUrl = Origin + "/owner/repo/releases/download/v1/runtime.zip", manifestUrl = Origin + "/owner/repo/releases/channel.json";
            string raw = SignManifest(appUrl, appZip, runtimeUrl, runtimeZip);
            var bodies = new Dictionary<string, byte[]>(StringComparer.Ordinal) { [manifestUrl] = Encoding.UTF8.GetBytes(raw), [appUrl] = appZip, [runtimeUrl] = runtimeZip };
            var transport = new FakeTransport(bodies); var privateKey = new Ed25519PrivateKeyParameters(PrivateKey, 0);
            var verifier = new Ed25519ChannelManifestSignatureVerifier(new Dictionary<string, byte[]> { [KeyId] = privateKey.GeneratePublicKey().GetEncoded() }); var trusted = new[] { new TrustedReleaseSource(Origin, "/owner/repo/") };
            using var client = new ChannelManifestClient(new ChannelManifestClientOptions { Url = manifestUrl, Channel = Channel, StateRoot = Path.Combine(root, "manifest-state"), SignatureVerifier = verifier, TrustedSources = trusted }, transport);
            ChannelManifestLoadResult loaded = await client.LoadAsync().ConfigureAwait(false); Need(loaded.Source == "network", "signed manifest loaded through fake transport");
            SelectedArtifactsV1 selected = loaded.Proof.SelectLatestArtifacts() ?? throw new InvalidOperationException("selection missing"); (VerifiedArtifactRequest appRequest, VerifiedArtifactRequest runtimeRequest) = loaded.Proof.CreateRequests(selected);
            var downloader = new ArtifactDownloader(new ArtifactDownloadOptions { StateRoot = Path.Combine(root, "download-state"), TrustedSources = trusted }, transport);
            VerifiedArtifactLease appDownload = await downloader.DownloadAsync(appRequest).ConfigureAwait(false); VerifiedArtifactLease runtimeDownload = await downloader.DownloadAsync(runtimeRequest).ConfigureAwait(false);
            var preparer = new ArtifactPreparer(new ArtifactPreparationOptions { StateRoot = Path.Combine(root, "prepare-state") }); PreparedArtifactLease appLease = await preparer.PrepareAsync(appDownload).ConfigureAwait(false); PreparedArtifactLease runtimeLease = await preparer.PrepareAsync(runtimeDownload).ConfigureAwait(false);
            return new Chain(downloader, appDownload, runtimeDownload, appLease, runtimeLease);
        }
        public async ValueTask DisposeAsync() { await App.DisposeAsync().ConfigureAwait(false); await Runtime.DisposeAsync().ConfigureAwait(false); await AppDownload.DisposeAsync().ConfigureAwait(false); await RuntimeDownload.DisposeAsync().ConfigureAwait(false); await appLease.DisposeAsync().ConfigureAwait(false); await runtimeLease.DisposeAsync().ConfigureAwait(false); downloader.Dispose(); }
    }

    private static byte[] MakeAppZip(string fakeAppDirectory)
    {
        var payload = Directory.EnumerateFiles(fakeAppDirectory).Where(static p => Path.GetFileName(p).StartsWith("FakeApp", StringComparison.OrdinalIgnoreCase)).ToDictionary(static p => Path.GetFileName(p), File.ReadAllBytes, StringComparer.OrdinalIgnoreCase);
        RequireFakeApp(fakeAppDirectory); return MakeZip(payload, files => new InstalledAppManifestV1(1, "magicpot-app", Version, Build, Commit, "win32", "x64", Runtime, "FakeApp.exe", CreatedAt, payload.Values.Sum(static x => (long)x.Length), files));
    }
    private static byte[] MakeRuntimeZip() { var payload = new Dictionary<string, byte[]> { ["python/python.exe"] = Encoding.UTF8.GetBytes("runtime-python"), ["comfy/main.py"] = Encoding.UTF8.GetBytes("print('smoke')") }; return MakeZip(payload, files => new InstalledRuntimeManifestV1(1, "magicpot-runtime", Runtime, "win32", "x64", CreatedAt, new RuntimeEntrypointsV1("python/python.exe", "comfy/main.py"), payload.Values.Sum(static x => (long)x.Length), files)); }
    private static byte[] MakeZip(Dictionary<string, byte[]> payload, Func<IReadOnlyList<InstalledFileV1>, object> factory)
    {
        IReadOnlyList<InstalledFileV1> files = payload.Select(static p => new InstalledFileV1(p.Key, p.Value.Length, Hash(p.Value))).ToArray(); byte[] manifest = Encoding.UTF8.GetBytes(Protocol.Serialize(factory(files))); using var output = new MemoryStream();
        using (var archive = new ZipArchive(output, ZipArchiveMode.Create, true, Encoding.UTF8)) { foreach (KeyValuePair<string, byte[]> pair in payload) { ZipArchiveEntry entry = archive.CreateEntry(pair.Key, CompressionLevel.NoCompression); entry.ExternalAttributes = 0x20; using Stream entryStream = entry.Open(); entryStream.Write(pair.Value); } ZipArchiveEntry manifestEntry = archive.CreateEntry("manifest.json", CompressionLevel.NoCompression); manifestEntry.ExternalAttributes = 0x20; using Stream manifestStream = manifestEntry.Open(); manifestStream.Write(manifest); }
        return output.ToArray();
    }
    private static string SignManifest(string appUrl, byte[] appZip, string runtimeUrl, byte[] runtimeZip)
    {
        long appUnpacked = ReadAppManifest(appZip).Item2; long runtimeUnpacked = ReadRuntimeManifest(runtimeZip).Item2;
        var app = new AppArtifactV1("app", Version, Build, Commit, Runtime, "win32", "x64", appUrl, Hash(appZip), appZip.Length, appUnpacked, "FakeApp.exe", CreatedAt); var runtime = new RuntimeArtifactV1("runtime", Runtime, "win32", "x64", runtimeUrl, Hash(runtimeZip), runtimeZip.Length, runtimeUnpacked, "python/python.exe", CreatedAt);
        var unsigned = new ChannelManifestV1(1, Channel, CreatedAt, new[] { new ChannelReleaseV1(Version, Build, Commit, CreatedAt, Origin + "/owner/repo/releases/tag/v1", "1.0.0", new ReleaseArtifactsV1(app, runtime)) }, new ManifestSignatureV1("ed25519", KeyId, Convert.ToBase64String(new byte[64])));
        byte[] payload = OfflineUpdateDecision.SigningPayload(unsigned); var signer = new Ed25519Signer(); signer.Init(true, new Ed25519PrivateKeyParameters(PrivateKey, 0)); signer.BlockUpdate(payload, 0, payload.Length); ChannelManifestV1 signed = unsigned with { Signature = new ManifestSignatureV1("ed25519", KeyId, Convert.ToBase64String(signer.GenerateSignature())) }; return JsonSerializer.Serialize(signed, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
    }
    private static (InstalledAppManifestV1, long) ReadAppManifest(byte[] zip) { using var input = new MemoryStream(zip); using var archive = new ZipArchive(input); using Stream stream = archive.GetEntry("manifest.json")!.Open(); using var reader = new StreamReader(stream); string text = reader.ReadToEnd(); return (Protocol.ParseAppManifest(text), archive.Entries.Sum(static e => e.Length)); }
    private static (InstalledRuntimeManifestV1, long) ReadRuntimeManifest(byte[] zip) { using var input = new MemoryStream(zip); using var archive = new ZipArchive(input); using Stream stream = archive.GetEntry("manifest.json")!.Open(); using var reader = new StreamReader(stream); string text = reader.ReadToEnd(); return (Protocol.ParseRuntimeManifest(text), archive.Entries.Sum(static e => e.Length)); }
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
}
