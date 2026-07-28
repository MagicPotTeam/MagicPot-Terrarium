using System.Security.Cryptography;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MagicPot.Launcher;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

if (!OperatingSystem.IsWindows()) { Console.Error.WriteLine("IntegrationHarness requires Windows."); return 2; }
var fakeAppDirectory = LocateFakeAppDirectory();
var tests = new (string Name, Func<Task> Body)[]
{
    ("healthy process confirms receipt", Healthy),
    ("early exit records one failure", EarlyExit),
    ("no confirmation times out", NoConfirm),
    ("health timeout terminates root and child", NoConfirmChild),
    ("integrity violation terminates root and child", IntegrityChild),
    ("normal root exit cleans surviving child", RootExitChild),
    ("job accounting reaches zero after terminating process tree", JobAccounting),
    ("third consecutive failure rolls back", Rollback),
    ("damaged active selects previous/newest and repairs", DamagedActive),
    ("activation journal recovers", JournalRecovery),
    ("launcher waits for concurrent activation commit", ConcurrentActivationCommit),
    ("notify available reaches process without auto coordinator", NotifyCapture),
    ("auto installed launches candidate", AutoInstalled),
    ("auto installed refreshes reset health before pending", AutoInstalledRefreshesHealth),
    ("installed without candidate activation falls back to old", AutoInstalledWithoutActivation),
    ("installed damaged candidate rolls back old", AutoInstalledDamagedCandidate),
    ("installed concurrent winner is preserved and launched", AutoInstalledConcurrentWinner),
    ("auto failure launches old process", () => AutoCapture(AutoUpdateResult.Failed("2.0.0", "fake", "test", "fake failure"), "failed")),
    ("auto artifact network unavailable launches old process", () => AutoCapture(AutoUpdateResult.Unavailable("2.0.0"), "unavailable")),
    ("unavailable reaches healthy process", () => UpdateCapture("notify-on-launch", FakeManifestFactory.Throw(ChannelManifestFailureKind.Unavailable), "unavailable", null)),
    ("failed reaches healthy process", () => UpdateCapture("notify-on-launch", FakeManifestFactory.Throw(ChannelManifestFailureKind.Failed), "failed", null)),
    ("disabled reaches healthy process", () => UpdateCapture("notify-on-launch", FakeManifestFactory.Available(), "disabled", null, enabled: false)),
    ("manual skips manifest client", ManualCapture),
    ("containment guardian collision cleans every ownership entry", ContainmentGuardianCollision),
};
var failures = 0;
foreach (var test in tests)
{
    try { await test.Body(); Console.WriteLine($"PASS {test.Name}"); }
    catch (Exception error) { failures++; Console.Error.WriteLine($"FAIL {test.Name}: {error}"); }
}
return failures == 0 ? 0 : 1;

async Task Healthy()
{
    using var fixture = new Fixture(fakeAppDirectory);
    fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
    fixture.WriteActive("20250101-010101-aaaaaaa", "runtime-a");
    await fixture.Engine().RunAsync(["healthy"]);
    var health = fixture.Health();
    Check(health.FailedAttemptCount == 0 && health.Pending is null, "healthy state was not cleared");
    Check(health.LastHealthy?.BuildId == "20250101-010101-aaaaaaa" && health.LastHealthy.RuntimeId == "runtime-a", "healthy receipt identity mismatch");
}

async Task EarlyExit()
{
    using var fixture = new Fixture(fakeAppDirectory);
    fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
    fixture.WriteActive("20250101-010101-aaaaaaa", "runtime-a");
    await ExpectFailure(fixture.Engine().RunAsync(["early-exit"]));
    Check(fixture.Health().FailedAttemptCount == 1, "early exit did not record exactly one failure");
}

async Task NoConfirm()
{
    using var fixture = new Fixture(fakeAppDirectory);
    fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
    fixture.WriteActive("20250101-010101-aaaaaaa", "runtime-a");
    await ExpectFailure(fixture.Engine().RunAsync(["no-confirm"]));
    Check(fixture.Health().FailedAttemptCount == 1, "no-confirm timeout did not record failure");
}

async Task NoConfirmChild()
{
    using var fixture = new Fixture(fakeAppDirectory);
    fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
    fixture.WriteActive("20250101-010101-aaaaaaa", "runtime-a");
    await fixture.RunWithPids("no-confirm-child", operation => ExpectFailure(operation));
}

async Task RootExitChild()
{
    using var fixture = new Fixture(fakeAppDirectory);
    fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
    fixture.WriteActive("20250101-010101-aaaaaaa", "runtime-a");
    await fixture.RunWithPids("spawn-child-exit-root", async operation => Check(await operation == 0, "normal root exit failed"));
}

async Task JobAccounting()
{
    using var fixture = new Fixture(fakeAppDirectory);
    fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
    fixture.WriteActive("20250101-010101-aaaaaaa", "runtime-a");
    InstalledSelection selection = new InstalledSelectionResolver(fixture.Layout).ResolveActive() ?? throw new Exception("installed selection was not resolved");
    using InstalledLaunchLease lease = InstalledLaunchLease.Acquire(fixture.Layout, selection);
    string executable = Path.Combine(selection.Installation.AppDirectory, selection.Installation.App.Entrypoint.Replace('/', Path.DirectorySeparatorChar));
    var startInfo = new ProcessStartInfo(executable) { WorkingDirectory = selection.Installation.AppDirectory, UseShellExecute = false };
    startInfo.ArgumentList.Add("no-confirm-child");
    using ControlledProcess controlled = new DirectInstalledProcessStarter().Start(lease, startInfo);
    Check(controlled.GetActiveProcessCount() >= 1, "running job did not report an active process");
    ProcessTreeTermination.TerminateAndWait(controlled);
    Check(controlled.GetActiveProcessCount() == 0, "terminated job did not report zero active processes");
    await Task.CompletedTask;
}

async Task ContainmentGuardianCollision()
{
    Fixture? firstFixture = null;
    Fixture? secondFixture = null;
    InstalledLaunchLease? firstLease = null;
    InstalledLaunchLease? secondLease = null;
    ControlledProcess? first = null;
    ControlledProcess? second = null;
    ControlledProcess? firstObserved = null;
    ControlledProcess? secondObserved = null;
    try
    {
        firstFixture = new Fixture(fakeAppDirectory);
        firstFixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
        firstFixture.WriteActive("20250101-010101-aaaaaaa", "runtime-a");
        InstalledSelection firstSelection = new InstalledSelectionResolver(firstFixture.Layout).ResolveActive() ?? throw new Exception("first installed selection was not resolved");
        string firstExecutable = Path.Combine(firstSelection.Installation.AppDirectory, firstSelection.Installation.App.Entrypoint.Replace('/', Path.DirectorySeparatorChar));
        firstLease = InstalledLaunchLease.Acquire(firstFixture.Layout, firstSelection);
        var firstStartInfo = new ProcessStartInfo(firstExecutable) { WorkingDirectory = firstSelection.Installation.AppDirectory, UseShellExecute = false };
        firstStartInfo.ArgumentList.Add("no-confirm");

        secondFixture = new Fixture(fakeAppDirectory);
        secondFixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
        secondFixture.WriteActive("20250101-010101-aaaaaaa", "runtime-a");
        InstalledSelection secondSelection = new InstalledSelectionResolver(secondFixture.Layout).ResolveActive() ?? throw new Exception("second installed selection was not resolved");
        string secondExecutable = Path.Combine(secondSelection.Installation.AppDirectory, secondSelection.Installation.App.Entrypoint.Replace('/', Path.DirectorySeparatorChar));
        secondLease = InstalledLaunchLease.Acquire(secondFixture.Layout, secondSelection);
        var secondStartInfo = new ProcessStartInfo(secondExecutable) { WorkingDirectory = secondSelection.Installation.AppDirectory, UseShellExecute = false };
        secondStartInfo.ArgumentList.Add("no-confirm");

        const string collisionId = "forced-containment-collision";
        ControlledProcess.ContainmentIdFactoryForTesting = () => collisionId;
        first = new DirectInstalledProcessStarter().Start(firstLease, firstStartInfo);
        second = new DirectInstalledProcessStarter().Start(secondLease, secondStartInfo);
        firstObserved = first; secondObserved = second;
        Check(first.ProcessId != second.ProcessId, "test processes unexpectedly shared a PID");

        ProcessContainmentRegistry.RejectRegistrationForTesting = null;
        ProcessContainmentRegistry.RegisterNoThrow(first, firstLease);
        first = null; firstLease = null;
        ProcessContainmentRegistry.RejectRegistrationForTesting = id => id == collisionId;
        ProcessContainmentRegistry.RegisterNoThrow(second, secondLease);
        second = null; secondLease = null;

        Check(await WaitForEmpty(firstObserved, TimeSpan.FromSeconds(5)), "normal registry guardian did not empty its job");
        Check(await WaitForEmpty(secondObserved, TimeSpan.FromSeconds(5)), "rejected registration fallback did not empty its job");
        bool filesReleased = false;
        for (int attempt = 0; attempt < 50 && !filesReleased; attempt++)
        {
            try
            {
                using (File.OpenWrite(firstExecutable)) { }
                using (File.OpenWrite(secondExecutable)) { }
                filesReleased = true;
            }
            catch (IOException) when (attempt < 49)
            {
                await Task.Delay(100);
            }
        }
        Check(filesReleased, "containment cleanup did not release executable handles");
    }
    finally
    {
        ControlledProcess.ContainmentIdFactoryForTesting = null;
        ProcessContainmentRegistry.RejectRegistrationForTesting = null;
        if (first is not null) { ProcessTreeTermination.TerminateAndWait(first); first.Dispose(); }
        if (second is not null) { ProcessTreeTermination.TerminateAndWait(second); second.Dispose(); }
        firstLease?.Dispose();
        secondLease?.Dispose();
        firstFixture?.Dispose();
        secondFixture?.Dispose();
    }
    await Task.CompletedTask;

    static async Task<bool> WaitForEmpty(ControlledProcess controlled, TimeSpan timeout)
    {
        Stopwatch elapsed = Stopwatch.StartNew();
        while (elapsed.Elapsed < timeout)
        {
            if (IsEmpty(controlled)) return true;
            await Task.Delay(25);
        }
        return IsEmpty(controlled);
    }

    static bool IsEmpty(ControlledProcess controlled)
    {
        try { return controlled.GetActiveProcessCount() == 0; }
        catch (ObjectDisposedException) { return true; }
    }
}

async Task IntegrityChild()
{
    using var fixture = new Fixture(fakeAppDirectory);
    fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
    fixture.WriteActive("20250101-010101-aaaaaaa", "runtime-a");
    string ready = Path.Combine(fixture.Root, "ready.marker");
    Environment.SetEnvironmentVariable("MAGICPOT_TEST_READY_MARKER", ready);
    try
    {
        await fixture.RunWithPids("hang-with-child", async operation =>
        {
            Check(SpinWait.SpinUntil(() => File.Exists(ready), TimeSpan.FromSeconds(5)), "healthy child mode did not become ready");
            File.WriteAllText(Path.Combine(fixture.Layout.Apps, "20250101-010101-aaaaaaa", "unexpected.bin"), "mutation");
            int exitCode = await operation;
            Check(exitCode == 73, "integrity violation did not return the dedicated exit code");
        });
    }
    finally { Environment.SetEnvironmentVariable("MAGICPOT_TEST_READY_MARKER", null); }
}

async Task Rollback()
{
    using var fixture = new Fixture(fakeAppDirectory);
    fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
    fixture.Install("20250102-010101-bbbbbbb", "runtime-b", "2025-01-02T01:01:01.000Z");
    fixture.WriteActive("20250102-010101-bbbbbbb", "runtime-b", "20250101-010101-aaaaaaa", "runtime-a");
    for (var attempt = 0; attempt < 3; attempt++) await ExpectFailure(fixture.Engine().RunAsync(["early-exit"]));
    var active = fixture.Active();
    Check(active.ActiveBuildId == "20250101-010101-aaaaaaa" && active.PreviousBuildId == "20250102-010101-bbbbbbb", "rollback pointer mismatch");
    Check(fixture.Health().FailedAttemptCount == 0 && fixture.Health().Pending is null, "rollback did not reset health");
}

async Task DamagedActive()
{
    using (var fixture = new Fixture(fakeAppDirectory))
    {
        fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
        fixture.WriteActive("20250103-010101-ccccccc", "runtime-missing", "20250101-010101-aaaaaaa", "runtime-a");
        await fixture.Engine().RunAsync(["healthy"]);
        Check(fixture.Active().ActiveBuildId == "20250101-010101-aaaaaaa", "valid previous was not selected/repaired");
    }
    foreach (var activeState in new[] { "damaged", "missing" })
    {
        using var fixture = new Fixture(fakeAppDirectory);
        fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
        fixture.Install("20250102-010101-bbbbbbb", "runtime-b", "2025-01-02T01:01:01.000Z");
        if (activeState == "damaged") File.WriteAllText(fixture.Layout.ActivePointer, "{ damaged");
        await fixture.Engine().RunAsync(["healthy"]);
        Check(fixture.Active().ActiveBuildId == "20250102-010101-bbbbbbb", activeState + " active did not select/repair newest installation");
        Check(!File.Exists(fixture.Layout.ActivationJournal), activeState + " active repair left an activation journal");
    }
}

async Task JournalRecovery()
{
    using var fixture = new Fixture(fakeAppDirectory);
    fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
    fixture.Install("20250102-010101-bbbbbbb", "runtime-b", "2025-01-02T01:01:01.000Z");
    var from = fixture.Pointer("20250101-010101-aaaaaaa", "runtime-a");
    var to = fixture.Pointer("20250102-010101-bbbbbbb", "runtime-b", from.ActiveBuildId, from.ActiveRuntimeId);
    AtomicJson.Write(fixture.Layout.ActivePointer, to);
    AtomicJson.Write(fixture.Layout.Health, new LauncherHealthStateV1(1, 2));
    AtomicJson.Write(fixture.Layout.ActivationJournal, new ActivationJournalV1(1, "prepared", Stamp(), from, to));
    await fixture.Engine().RunAsync(["healthy"]);
    Check(!File.Exists(fixture.Layout.ActivationJournal), "journal was not deleted");
    Check(fixture.Health().FailedAttemptCount == 0, "committed journal recovery did not reset health");
    Check(fixture.Health().LastHealthy?.BuildId == to.ActiveBuildId, "journal recovery did not continue through health locking and launch");
}

async Task ConcurrentActivationCommit()
{
    using var fixture = new Fixture(fakeAppDirectory);
    fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
    fixture.Install("20250102-010101-bbbbbbb", "runtime-b", "2025-01-02T01:01:01.000Z");
    fixture.WriteActive("20250101-010101-aaaaaaa", "runtime-a");
    var from = fixture.Active();
    var to = fixture.Pointer("20250102-010101-bbbbbbb", "runtime-b", from.ActiveBuildId, from.ActiveRuntimeId);
    using var commitBlocked = new ManualResetEventSlim();
    using var releaseCommit = new ManualResetEventSlim();
    ActivationStateTransactionScope.BeforeHandleRename = temporary =>
    {
        if (!Path.GetFileName(temporary).StartsWith(".active.json.tmp-", StringComparison.OrdinalIgnoreCase)) return;
        commitBlocked.Set();
        releaseCommit.Wait(TimeSpan.FromSeconds(10));
    };
    Task commit = Task.CompletedTask;
    Task launch = Task.CompletedTask;
    try
    {
        commit = Task.Run(() => LocalActivationStore.Commit(fixture.Layout, from, to, DateTimeOffset.UtcNow));
        Check(commitBlocked.Wait(TimeSpan.FromSeconds(5)), "activation commit did not reach the blocked active publish");
        Check(File.Exists(fixture.Layout.ActivationJournal), "blocked commit did not retain its activation journal");
        launch = Task.Run(() => fixture.Engine().RunAsync(["healthy"]));
        await Task.Delay(250);
        Check(!launch.IsCompleted, "launcher did not wait for the activation update lock");
        Check(File.Exists(fixture.Layout.ActivationJournal), "waiting launcher deleted the in-flight activation journal");
        releaseCommit.Set();
        Check(await Task.WhenAny(commit, Task.Delay(TimeSpan.FromSeconds(10))) == commit, "activation commit did not finish after release");
        await commit;
        Check(await Task.WhenAny(launch, Task.Delay(TimeSpan.FromSeconds(10))) == launch, "launcher did not finish after activation commit");
        await launch;
        Check(fixture.Active().ActiveBuildId == to.ActiveBuildId, "launcher did not resolve the newly committed active build");
        Check(fixture.Health().LastHealthy?.BuildId == to.ActiveBuildId, "launcher did not start the newly committed active build");
    }
    finally
    {
        releaseCommit.Set();
        ActivationStateTransactionScope.BeforeHandleRename = null;
        await AwaitCleanupTask(commit, "activation commit cleanup");
        await AwaitCleanupTask(launch, "launcher cleanup");
    }
}

async Task AwaitCleanupTask(Task task, string label)
{
    if (await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(10))) != task)
        throw new TimeoutException(label + " timed out");
    await task;
}

async Task UpdateCapture(string mode, FakeManifestFactory factory, string expectedStatus, string? expectedVersion, bool enabled = true)
{
    using var fixture = new Fixture(fakeAppDirectory);
    fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
    fixture.WriteActive("20250101-010101-aaaaaaa", "runtime-a");
    fixture.WriteSettings(mode);
    await fixture.RunCaptured(factory, enabled);
    fixture.AssertCapture(mode, expectedStatus, expectedVersion);
    Check(fixture.Health().LastHealthy is not null, "update result prevented healthy confirmation");
}

async Task NotifyCapture()
{
    var coordinator = new FakeAutoUpdateCoordinatorFactory(AutoUpdateResult.Installed("2.0.0"));
    using var fixture = new Fixture(fakeAppDirectory);
    fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
    fixture.WriteActive("20250101-010101-aaaaaaa", "runtime-a");
    fixture.WriteSettings("notify-on-launch");
    await fixture.RunCaptured(FakeManifestFactory.Available(), enabled: true, coordinator);
    fixture.AssertCapture("notify-on-launch", "available", "2.0.0");
    Check(coordinator.CreateCount == 0, "notify mode constructed auto coordinator");
}

async Task AutoInstalled()
{
    using var fixture = new Fixture(fakeAppDirectory);
    fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
    fixture.WriteActive("20250101-010101-aaaaaaa", "runtime-a");
    fixture.WriteSettings("auto-on-launch");
    var coordinator = new InstallingAutoUpdateCoordinatorFactory(fixture);
    await fixture.RunCaptured(FakeManifestFactory.Available(), enabled: true, coordinator);
    fixture.AssertCapture("auto-on-launch", "installed", "2.0.0", "20250102-010101-bbbbbbb", "runtime-b");
    Check(fixture.Active().ActiveBuildId == "20250102-010101-bbbbbbb", "candidate was not active after installed result");
}

async Task AutoInstalledRefreshesHealth()
{
    using var fixture = new Fixture(fakeAppDirectory);
    fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
    fixture.WriteActive("20250101-010101-aaaaaaa", "runtime-a");
    AtomicJson.Write(fixture.Layout.Health, new LauncherHealthStateV1(1, 2));
    fixture.WriteSettings("auto-on-launch");
    await ExpectFailure(fixture.Engine(factory: FakeManifestFactory.Available(), enabled: true, coordinatorFactory: new InstallingAutoUpdateCoordinatorFactory(fixture)).RunAsync(["early-exit"]));
    Check(fixture.Health().FailedAttemptCount == 1, "installed activation reused stale pre-update health or rolled back immediately");
    Check(fixture.Active().ActiveBuildId == "20250102-010101-bbbbbbb", "candidate rolled back on its first failed launch");
}

async Task AutoInstalledWithoutActivation()
{
    using var fixture = AutoFixture();
    await fixture.RunCaptured(FakeManifestFactory.Available(), enabled: true, new FakeAutoUpdateCoordinatorFactory(AutoUpdateResult.Installed("2.0.0")));
    fixture.AssertCapture("auto-on-launch", "failed", null);
    Check(fixture.Active().ActiveBuildId == "20250101-010101-aaaaaaa", "old active pointer changed when coordinator did not activate candidate");
}

async Task AutoInstalledDamagedCandidate()
{
    using var fixture = AutoFixture();
    await fixture.RunCaptured(FakeManifestFactory.Available(), enabled: true, new MutatingInstalledCoordinatorFactory(fixture, InstalledMutation.DamagedCandidate));
    fixture.AssertCapture("auto-on-launch", "failed", null);
    Check(fixture.Active().ActiveBuildId == "20250101-010101-aaaaaaa", "damaged candidate was not rolled back to old active");
}

async Task AutoInstalledConcurrentWinner()
{
    using var fixture = AutoFixture();
    await fixture.RunCaptured(FakeManifestFactory.Available(), enabled: true, new MutatingInstalledCoordinatorFactory(fixture, InstalledMutation.ConcurrentWinner));
    fixture.AssertCapture("auto-on-launch", "failed", null, "20250103-010101-ccccccc", "runtime-c");
    Check(fixture.Active().ActiveBuildId == "20250103-010101-ccccccc", "concurrent winner was overwritten by candidate rollback");
}

Fixture AutoFixture()
{
    var fixture = new Fixture(fakeAppDirectory);
    fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
    fixture.WriteActive("20250101-010101-aaaaaaa", "runtime-a");
    fixture.WriteSettings("auto-on-launch");
    return fixture;
}

async Task AutoCapture(AutoUpdateResult result, string expectedStatus)
{
    var coordinator = new FakeAutoUpdateCoordinatorFactory(result);
    using var fixture = new Fixture(fakeAppDirectory);
    fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
    fixture.WriteActive("20250101-010101-aaaaaaa", "runtime-a");
    fixture.WriteSettings("auto-on-launch");
    await fixture.RunCaptured(FakeManifestFactory.Available(), enabled: true, coordinator);
    fixture.AssertCapture("auto-on-launch", expectedStatus, null);
    Check(coordinator.CreateCount == 1 && coordinator.Coordinator.ExecuteCount == 1, "auto coordinator invocation mismatch");
    Check(fixture.Health().FailedAttemptCount == 0, "auto update failure counted as health failure");
}

async Task ManualCapture()
{
    var factory = FakeManifestFactory.Available();
    using var fixture = new Fixture(fakeAppDirectory);
    fixture.Install("20250101-010101-aaaaaaa", "runtime-a", "2025-01-01T01:01:01.000Z");
    fixture.WriteActive("20250101-010101-aaaaaaa", "runtime-a");
    fixture.WriteSettings("manual");
    await fixture.RunCaptured(factory, enabled: true);
    fixture.AssertCapture("manual", "manual", null);
    Check(factory.CreateCount == 0, "manual mode called manifest factory");
}

static async Task ExpectFailure(Task operation)
{
    try { await operation; }
    catch (InvalidOperationException) { return; }
    throw new Exception("expected launch failure");
}
static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
static string Stamp() => LauncherTime.Timestamp(DateTimeOffset.UtcNow);

static string LocateFakeAppDirectory()
{
    var explicitDirectory = Environment.GetEnvironmentVariable("MAGICPOT_FAKE_APP_DIR");
    if (!string.IsNullOrWhiteSpace(explicitDirectory))
    {
        var fullPath = Path.GetFullPath(explicitDirectory);
        if (File.Exists(Path.Combine(fullPath, "FakeApp.exe"))) return fullPath;
        throw new DirectoryNotFoundException($"MAGICPOT_FAKE_APP_DIR does not contain FakeApp.exe: {fullPath}");
    }
    var integrationProject = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", ".."));
    var project = Path.Combine(Path.GetDirectoryName(integrationProject)!, "MagicPot.Launcher.FakeApp");
    var executable = Directory.EnumerateFiles(project, "FakeApp.exe", SearchOption.AllDirectories)
        .Where(path => path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase))
        .OrderByDescending(File.GetLastWriteTimeUtc).FirstOrDefault();
    return executable is null ? throw new FileNotFoundException("Build MagicPot.Launcher.FakeApp before running the harness") : Path.GetDirectoryName(executable)!;
}

sealed class Fixture : IDisposable
{
    private readonly string fakeAppDirectory;
    private readonly HashSet<string> fakeAppFiles;
    public string Root { get; } = Path.Combine(Path.GetTempPath(), "MagicPot-Launcher-Integration-" + Guid.NewGuid().ToString("N"));
    public LauncherLayout Layout { get; }
    public Fixture(string fakeAppDirectory)
    {
        this.fakeAppDirectory = fakeAppDirectory;
        fakeAppFiles = Directory.EnumerateFiles(fakeAppDirectory).Select(Path.GetFileName).Where(name => name is not null).Select(name => name!).ToHashSet(StringComparer.OrdinalIgnoreCase);
        Layout = LauncherLayout.Create(Root);
        Directory.CreateDirectory(Layout.Apps); Directory.CreateDirectory(Layout.Runtimes);
    }
    public LauncherEngine Engine(IChannelManifestClientFactory? factory = null, bool enabled = false, IAutoUpdateCoordinatorFactory? coordinatorFactory = null) => new(Layout, healthTimeout: TimeSpan.FromSeconds(2), updateConfiguration: Configuration(enabled), manifestClientFactory: factory, autoUpdateCoordinatorFactory: coordinatorFactory);
    private static LauncherUpdateConfiguration Configuration(bool enabled) => new(enabled, "1.0.0", new Dictionary<string, string>(StringComparer.Ordinal) { ["stable"] = "https://updates.example.test/stable.json" }, OfflineUpdateDecision.DefaultTrustedReleaseSources, new Dictionary<string, byte[]>(StringComparer.Ordinal));
    public void WriteSettings(string mode) => AtomicJson.Write(Path.Combine(Root, "settings.json"), new LauncherSettingsV1(1, mode, "stable", 3, 3, false));
    public async Task RunWithPids(string mode, Func<Task<int>, Task> assertion)
    {
        string rootPidPath = Path.Combine(Root, "root.pid");
        string childPidPath = Path.Combine(Root, "child.pid");
        string grandchildPidPath = Path.Combine(Root, "grandchild.pid");
        Environment.SetEnvironmentVariable("MAGICPOT_TEST_ROOT_PID_PATH", rootPidPath);
        Environment.SetEnvironmentVariable("MAGICPOT_TEST_CHILD_PID_PATH", childPidPath);
        Environment.SetEnvironmentVariable("MAGICPOT_TEST_GRANDCHILD_PID_PATH", grandchildPidPath);
        var stopwatch = Stopwatch.StartNew();
        try
        {
            Task<int> operation = Engine().RunAsync([mode]);
            Require(SpinWait.SpinUntil(() => File.Exists(rootPidPath) && File.Exists(childPidPath) && File.Exists(grandchildPidPath), TimeSpan.FromSeconds(5)), "root/child/grandchild pid files were not created");
            await assertion(operation);
            Require(stopwatch.Elapsed < TimeSpan.FromSeconds(12), "launcher termination was not bounded");
            AssertExited(int.Parse(File.ReadAllText(rootPidPath), CultureInfo.InvariantCulture), "root");
            AssertExited(int.Parse(File.ReadAllText(childPidPath), CultureInfo.InvariantCulture), "child");
            AssertExited(int.Parse(File.ReadAllText(grandchildPidPath), CultureInfo.InvariantCulture), "grandchild");
        }
        finally
        {
            Environment.SetEnvironmentVariable("MAGICPOT_TEST_ROOT_PID_PATH", null);
            Environment.SetEnvironmentVariable("MAGICPOT_TEST_CHILD_PID_PATH", null);
            Environment.SetEnvironmentVariable("MAGICPOT_TEST_GRANDCHILD_PID_PATH", null);
        }
    }
    private static void AssertExited(int pid, string name)
    {
        Require(SpinWait.SpinUntil(() => !IsAlive(pid), TimeSpan.FromSeconds(3)), $"{name} process {pid} remained alive");
    }
    private static bool IsAlive(int pid)
    {
        try { using Process process = Process.GetProcessById(pid); return !process.HasExited; }
        catch (ArgumentException) { return false; }
    }
    public async Task RunCaptured(IChannelManifestClientFactory factory, bool enabled, IAutoUpdateCoordinatorFactory? coordinatorFactory = null)
    {
        var capture = Path.Combine(Root, "update-capture.json");
        Environment.SetEnvironmentVariable("MAGICPOT_TEST_ENV_CAPTURE", capture);
        try { await Engine(factory, enabled, coordinatorFactory).RunAsync(["healthy"]); }
        finally { Environment.SetEnvironmentVariable("MAGICPOT_TEST_ENV_CAPTURE", null); }
    }
    private static void Require(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }
    public void AssertCapture(string mode, string status, string? version, string build = "20250101-010101-aaaaaaa", string runtime = "runtime-a")
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(Root, "update-capture.json")));
        var root = document.RootElement;
        Require(root.EnumerateObject().Select(property => property.Name).SequenceEqual(["updateMode", "status", "channel", "version", "launch"]), "capture contains unexpected fields");
        Require(root.GetProperty("updateMode").GetString() == mode, "captured update mode mismatch");
        Require(root.GetProperty("status").GetString() == status, "captured update status mismatch");
        Require(root.GetProperty("channel").GetString() == "stable", "captured channel mismatch");
        Require(version is null ? root.GetProperty("version").ValueKind == JsonValueKind.Null : root.GetProperty("version").GetString() == version, "captured version mismatch");
        var launch = root.GetProperty("launch");
        Require(launch.GetProperty("build").GetString() == build && launch.GetProperty("runtime").GetString() == runtime, "captured launch identity mismatch");
    }
    private static string CurrentStamp() => DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
    public ActivePointerV1 Pointer(string build, string runtime, string? previousBuild = null, string? previousRuntime = null) => new(1, build, runtime, previousBuild, previousRuntime, CurrentStamp());
    public void WriteActive(string build, string runtime, string? previousBuild = null, string? previousRuntime = null) => AtomicJson.Write(Layout.ActivePointer, Pointer(build, runtime, previousBuild, previousRuntime));
    public ActivePointerV1 Active() => Protocol.ParseActivePointer(File.ReadAllText(Layout.ActivePointer));
    public LauncherHealthStateV1 Health() => Protocol.ParseHealth(File.ReadAllText(Layout.Health));

    public void Install(string build, string runtime, string createdAt)
    {
        var app = Path.Combine(Layout.Apps, build); var runtimeDirectory = Path.Combine(Layout.Runtimes, runtime);
        Directory.CreateDirectory(app); Directory.CreateDirectory(runtimeDirectory);
        foreach (var name in fakeAppFiles) File.Copy(Path.Combine(fakeAppDirectory, name), Path.Combine(app, name), true);
        var appFiles = fakeAppFiles.Select(name => FileRecord(Path.Combine(app, name))).ToArray();
        var appSize = appFiles.Sum(file => file.Size);
        AtomicJson.Write(Path.Combine(app, "manifest.json"), new InstalledAppManifestV1(1, "magicpot-app", "1.0.0", build, build[^7..] + new string('0', 33), "win32", "x64", runtime, "FakeApp.exe", createdAt, appSize, appFiles));
        File.WriteAllBytes(Path.Combine(runtimeDirectory, "python.exe"), [0x4d, 0x5a]);
        File.WriteAllText(Path.Combine(runtimeDirectory, "main.py"), "# integration fixture\n");
        var runtimeFiles = Directory.EnumerateFiles(runtimeDirectory).Select(FileRecord).ToArray();
        AtomicJson.Write(Path.Combine(runtimeDirectory, "manifest.json"), new InstalledRuntimeManifestV1(1, "magicpot-runtime", runtime, "win32", "x64", createdAt, new("python.exe", "main.py"), runtimeFiles.Sum(file => file.Size), runtimeFiles));
    }
    private static InstalledFileV1 FileRecord(string path)
    {
        using var stream = File.OpenRead(path);
        return new(Path.GetFileName(path), stream.Length, Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant());
    }
    public void Dispose() { try { Directory.Delete(Root, true); } catch { } }
}

sealed class InstallingAutoUpdateCoordinatorFactory(Fixture fixture) : IAutoUpdateCoordinatorFactory
{
    public IAutoUpdateCoordinator Create() => new InstallingAutoUpdateCoordinator(fixture);
}

sealed class InstallingAutoUpdateCoordinator(Fixture fixture) : IAutoUpdateCoordinator
{
    public Task<AutoUpdateResult> ExecuteAsync(LauncherLayout layout, LauncherSettingsV1 settings, LauncherUpdateConfiguration configuration,
        ChannelManifestLoadResult manifest, SelectedArtifactsV1 candidate, SelectedArtifactsV1? currentActive = null, CancellationToken cancellationToken = default)
    {
        fixture.Install(candidate.App.BuildId, candidate.Runtime.RuntimeId, candidate.App.CreatedAt);
        fixture.WriteActive(candidate.App.BuildId, candidate.Runtime.RuntimeId, currentActive!.App.BuildId, currentActive.Runtime.RuntimeId);
        AtomicJson.Write(fixture.Layout.Health, new LauncherHealthStateV1(1, 0));
        return Task.FromResult(AutoUpdateResult.Installed(candidate.Release.Version));
    }
}

enum InstalledMutation { DamagedCandidate, ConcurrentWinner }

sealed class MutatingInstalledCoordinatorFactory(Fixture fixture, InstalledMutation mutation) : IAutoUpdateCoordinatorFactory
{
    public IAutoUpdateCoordinator Create() => new MutatingInstalledCoordinator(fixture, mutation);
}

sealed class MutatingInstalledCoordinator(Fixture fixture, InstalledMutation mutation) : IAutoUpdateCoordinator
{
    public Task<AutoUpdateResult> ExecuteAsync(LauncherLayout layout, LauncherSettingsV1 settings, LauncherUpdateConfiguration configuration,
        ChannelManifestLoadResult manifest, SelectedArtifactsV1 candidate, SelectedArtifactsV1? currentActive = null, CancellationToken cancellationToken = default)
    {
        if (mutation == InstalledMutation.DamagedCandidate)
        {
            fixture.WriteActive(candidate.App.BuildId, candidate.Runtime.RuntimeId, currentActive!.App.BuildId, currentActive.Runtime.RuntimeId);
        }
        else
        {
            fixture.Install("20250103-010101-ccccccc", "runtime-c", "2025-01-03T01:01:01.000Z");
            fixture.WriteActive("20250103-010101-ccccccc", "runtime-c", currentActive!.App.BuildId, currentActive.Runtime.RuntimeId);
        }
        return Task.FromResult(AutoUpdateResult.Installed(candidate.Release.Version));
    }
}

sealed class FakeAutoUpdateCoordinatorFactory(AutoUpdateResult result) : IAutoUpdateCoordinatorFactory
{
    public int CreateCount { get; private set; }
    public FakeAutoUpdateCoordinator Coordinator { get; } = new(result);
    public IAutoUpdateCoordinator Create() { CreateCount++; return Coordinator; }
}

sealed class FakeAutoUpdateCoordinator(AutoUpdateResult result) : IAutoUpdateCoordinator
{
    public int ExecuteCount { get; private set; }
    public Task<AutoUpdateResult> ExecuteAsync(LauncherLayout layout, LauncherSettingsV1 settings, LauncherUpdateConfiguration configuration,
        ChannelManifestLoadResult manifest, SelectedArtifactsV1 candidate, SelectedArtifactsV1? currentActive = null, CancellationToken cancellationToken = default)
    {
        ExecuteCount++;
        if (currentActive is null || currentActive.App.BuildId != "20250101-010101-aaaaaaa") throw new InvalidOperationException("engine did not pass current baseline");
        return Task.FromResult(result);
    }
}

sealed class FakeManifestFactory : IChannelManifestClientFactory
{
    private readonly ChannelManifestLoadResult? result;
    private readonly ChannelManifestClientException? error;
    public int CreateCount { get; private set; }
    private FakeManifestFactory(ChannelManifestLoadResult? result, ChannelManifestClientException? error) { this.result = result; this.error = error; }
    public static FakeManifestFactory Available()
    {
        const string build = "20250102-010101-bbbbbbb";
        const string runtime = "runtime-b";
        const string commit = "bbbbbbb000000000000000000000000000000000";
        const string stamp = "2025-01-02T01:01:01.000Z";
        const string hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        var app = new AppArtifactV1("app", "2.0.0", build, commit, runtime, "win32", "x64", "https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/download/v2/app.zip", hash, 1, 1, "FakeApp.exe", stamp);
        var runtimeArtifact = new RuntimeArtifactV1("runtime", runtime, "win32", "x64", "https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/download/v2/runtime.zip", hash, 1, 1, "python.exe", stamp);
        var release = new ChannelReleaseV1("2.0.0", build, commit, stamp, "https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/tag/v2", "1.0.0", new ReleaseArtifactsV1(app, runtimeArtifact));
        var unsigned = new ChannelManifestV1(1, "stable", stamp, [release], new ManifestSignatureV1("ed25519", "test", Convert.ToBase64String(new byte[64])));
        var privateKey = new Ed25519PrivateKeyParameters(Enumerable.Range(1, 32).Select(static value => (byte)value).ToArray(), 0);
        var payload = OfflineUpdateDecision.SigningPayload(unsigned);
        var signer = new Ed25519Signer();
        signer.Init(true, privateKey);
        signer.BlockUpdate(payload, 0, payload.Length);
        var signed = unsigned with { Signature = unsigned.Signature with { Value = Convert.ToBase64String(signer.GenerateSignature()) } };
        var raw = JsonSerializer.Serialize(signed, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        var verifier = new Ed25519ChannelManifestSignatureVerifier(new Dictionary<string, byte[]> { ["test"] = privateKey.GeneratePublicKey().GetEncoded() });
        var proof = OfflineUpdateDecision.ParseAndVerifyChannelManifest(raw, "stable", verifier);
        return new(new ChannelManifestLoadResult(proof, "fake"), null);
    }
    public static FakeManifestFactory Throw(ChannelManifestFailureKind kind) => new(null, new ChannelManifestClientException("fake", kind));
    public IChannelManifestClient Create(ChannelManifestClientOptions options) { CreateCount++; return new FakeManifestClient(result, error); }
}

sealed class FakeManifestClient(ChannelManifestLoadResult? result, ChannelManifestClientException? error) : IChannelManifestClient
{
    public Task<ChannelManifestLoadResult> LoadAsync(CancellationToken cancellationToken = default) => error is null ? Task.FromResult(result!) : Task.FromException<ChannelManifestLoadResult>(error);
    public void Dispose() { }
}
