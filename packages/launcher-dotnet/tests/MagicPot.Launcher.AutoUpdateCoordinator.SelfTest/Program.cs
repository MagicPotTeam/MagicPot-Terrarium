using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

namespace MagicPot.Launcher;

internal static class AutoUpdateCoordinatorSelfTest
{
    private const string Channel = "stable";
    private const string KeyId = "auto-coordinator-selftest-key";
    private const string CreatedAt = "2025-01-02T03:04:05.000Z";
    private const string OldCreatedAt = "2025-01-01T03:04:05.000Z";
    private const string Commit = "0123456789abcdef0123456789abcdef01234567";
    private const string OldCommit = "abcdef0123456789abcdef0123456789abcdef01";
    private const string Build = "20250102-030405-0123456";
    private const string OldBuild = "20250101-030405-abcdef0";
    private const string WinnerBuild = "20250103-030405-fedcba9";
    private const string Runtime = "python-3.11.9-auto-selftest";
    private const string OldRuntime = "python-3.11.8-auto-selftest";
    private const string Version = "2.0.0";
    private const string OldVersion = "1.0.0";
    private const string Origin = "https://auto-coordinator-selftest.invalid";
    private const string ManifestUrl = Origin + "/owner/repo/releases/channel.json";
    private const string AppUrl = Origin + "/owner/repo/releases/download/v2/app.zip";
    private const string RuntimeUrl = Origin + "/owner/repo/releases/download/v2/runtime.zip";
    private static readonly byte[] PrivateKey = Convert.FromHexString("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F");
    private static int assertions;

    public static async Task<int> Main()
    {
        if (!OperatingSystem.IsWindows())
        {
            Console.WriteLine("SKIP: Windows-only AutoUpdateCoordinator self-test.");
            return 0;
        }

        string fakeAppDirectory = Environment.GetEnvironmentVariable("MAGICPOT_FAKE_APP_DIR")
            ?? throw new InvalidOperationException("MAGICPOT_FAKE_APP_DIR is required.");
        fakeAppDirectory = Path.GetFullPath(fakeAppDirectory);
        RequireFakeApp(fakeAppDirectory);
        string parent = Path.Combine(Path.GetTempPath(), "MagicPot-AutoCoordinator-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(parent);
        try
        {
            await Success(parent, fakeAppDirectory).ConfigureAwait(false);
            await AlreadyActive(parent, fakeAppDirectory).ConfigureAwait(false);
            await ForgedAlreadyActiveCandidate(parent, fakeAppDirectory).ConfigureAwait(false);
            await PolicyRejections(parent, fakeAppDirectory).ConfigureAwait(false);
            await TransportUnavailable(parent, fakeAppDirectory).ConfigureAwait(false);
            await HashMismatch(parent, fakeAppDirectory).ConfigureAwait(false);
            await InvalidZip(parent, fakeAppDirectory).ConfigureAwait(false);
            await ConflictingFinal(parent, fakeAppDirectory).ConfigureAwait(false);
            await SmokeNonzero(parent, fakeAppDirectory).ConfigureAwait(false);
            await CrossReleaseRuntime(parent, fakeAppDirectory).ConfigureAwait(false);
            await Cancellation(parent, fakeAppDirectory).ConfigureAwait(false);
            await StaleActivation(parent, fakeAppDirectory).ConfigureAwait(false);
            await MissingBaseline(parent, fakeAppDirectory).ConfigureAwait(false);
            await StaleBaselineFiles(parent, fakeAppDirectory).ConfigureAwait(false);
            await FinalVerificationRollback(parent, fakeAppDirectory).ConfigureAwait(false);
            await FinalVerificationConcurrentWinner(parent, fakeAppDirectory).ConfigureAwait(false);
            Console.WriteLine($"PASS: AutoUpdateCoordinator real chain; {assertions} assertions.");
            return 0;
        }
        finally
        {
            TryDelete(parent);
        }
    }

    private static async Task Success(string parent, string fakeAppDirectory)
    {
        await using Scenario scenario = await Scenario.CreateAsync(parent, "01-success", fakeAppDirectory).ConfigureAwait(false);
        scenario.SeedOldActive();
        AutoUpdateResult result = await scenario.ExecuteAsync().ConfigureAwait(false);
        Need(result.Status == "installed" && result.Version == Version && result.Error is null, "success reports installed/version");
        ActivePointerV1 active = scenario.ReadActive();
        Need(active.ActiveBuildId == Build && active.ActiveRuntimeId == Runtime, "success activates candidate pair");
        Need(active.PreviousBuildId == OldBuild && active.PreviousRuntimeId == OldRuntime, "success records previous old pair");
        Need(scenario.Transport.RequestCount == 2, "success downloads app and runtime");
        scenario.AssertClean(noJournal: true);
    }

    private static async Task AlreadyActive(string parent, string fakeAppDirectory)
    {
        await using Scenario scenario = await Scenario.CreateAsync(parent, "02-already-active", fakeAppDirectory).ConfigureAwait(false);
        scenario.SeedCandidateActive();
        AutoUpdateResult result = await scenario.ExecuteAsync().ConfigureAwait(false);
        Need(result.Status == "up-to-date" && result.Version == Version && result.Error is null, "active candidate is up-to-date");
        Need(scenario.Transport.RequestCount == 0, "up-to-date makes zero artifact requests");
        scenario.AssertClean(noJournal: true);
    }

    private static async Task ForgedAlreadyActiveCandidate(string parent, string fakeAppDirectory)
    {
        await using Scenario scenario = await Scenario.CreateAsync(parent, "02b-forged-active", fakeAppDirectory).ConfigureAwait(false);
        scenario.SeedCandidateActive();
        AppArtifactV1 forgedApp = scenario.Candidate.App with { Version = "99.0.0", Url = Origin + "/forged/app.zip" };
        SelectedArtifactsV1 forged = scenario.Candidate with { App = forgedApp };
        AutoUpdateResult result = await scenario.ExecuteAsync(candidate: forged).ConfigureAwait(false);
        Need(result.Status == "failed" && result.Version is null, "forged active candidate version is not trusted");
        Need(result.Error?.Stage == "capability" && result.Error.Code == "candidate-not-capable", "forged active candidate fails capability before up-to-date");
        Need(scenario.Transport.RequestCount == 0, "forged active candidate makes zero artifact requests");
        Need(scenario.ReadActive().ActiveBuildId == Build, "forged active candidate does not alter active");
        scenario.AssertClean(noJournal: true);
    }

    private static async Task PolicyRejections(string parent, string fakeAppDirectory)
    {
        foreach (string mode in new[] { "manual", "notify" })
        {
            await using Scenario scenario = await Scenario.CreateAsync(parent, "03-policy-" + mode, fakeAppDirectory).ConfigureAwait(false);
            scenario.SeedOldActive();
            AutoUpdateResult result = await scenario.ExecuteAsync(mode).ConfigureAwait(false);
            Need(result.Status == "failed" && result.Error?.Code == "mode-not-auto" && result.Error.Stage == "policy", mode + " rejected by policy");
            Need(scenario.Transport.RequestCount == 0, mode + " makes zero artifact requests");
            scenario.AssertOldActive();
            scenario.AssertClean(noJournal: true);
        }
    }

    private static async Task TransportUnavailable(string parent, string fakeAppDirectory)
    {
        await using Scenario scenario = await Scenario.CreateAsync(parent, "04-transport", fakeAppDirectory).ConfigureAwait(false);
        scenario.SeedOldActive();
        scenario.Transport.SetException(AppUrl, new HttpRequestException("offline"));
        scenario.Transport.SetException(RuntimeUrl, new HttpRequestException("offline"));
        AutoUpdateResult result = await scenario.ExecuteAsync().ConfigureAwait(false);
        Need(result.Status == "unavailable" && result.Version == Version, "transport failure reports unavailable/version");
        Need(result.Error?.Code == "transport-unavailable" && result.Error.Stage == "download", "transport failure classified as download");
        scenario.AssertOldActive();
        scenario.AssertClean(noJournal: true);
    }

    private static async Task HashMismatch(string parent, string fakeAppDirectory)
    {
        await using Scenario scenario = await Scenario.CreateAsync(parent, "05-hash", fakeAppDirectory, appDigestOverride: new string('0', 64)).ConfigureAwait(false);
        scenario.SeedOldActive();
        AutoUpdateResult result = await scenario.ExecuteAsync().ConfigureAwait(false);
        Need(result.Status == "failed" && result.Error?.Code == "download-invalid" && result.Error.Stage == "download", "app hash mismatch fails download");
        Need(scenario.Transport.RequestCount == 2, "app download failure still exercises successful runtime download");
        scenario.AssertOldActive();
        scenario.AssertClean(noJournal: true);
        scenario.AssertStateTreeUnoccupied("download-state", "partial-success download leases are released");
    }

    private static async Task InvalidZip(string parent, string fakeAppDirectory)
    {
        byte[] invalid = Encoding.UTF8.GetBytes("this is not a zip archive");
        await using Scenario scenario = await Scenario.CreateAsync(parent, "06-invalid-zip", fakeAppDirectory, appBytesOverride: invalid).ConfigureAwait(false);
        scenario.SeedOldActive();
        AutoUpdateResult result = await scenario.ExecuteAsync().ConfigureAwait(false);
        Need(result.Status == "failed" && result.Error?.Code == "prepare-failed" && result.Error.Stage == "prepare", "valid-hash invalid zip fails prepare");
        Need(scenario.Transport.RequestCount == 2, "app prepare failure follows two successful downloads");
        scenario.AssertOldActive();
        scenario.AssertClean(noJournal: true);
        scenario.AssertStateTreeUnoccupied("download-state", "prepare failure releases input download leases");
        scenario.AssertStateTreeUnoccupied("prepare-state", "partial-success prepare leases are released");
    }

    private static async Task ConflictingFinal(string parent, string fakeAppDirectory)
    {
        await using Scenario scenario = await Scenario.CreateAsync(parent, "07-conflicting-final", fakeAppDirectory).ConfigureAwait(false);
        scenario.SeedOldActive();
        Directory.CreateDirectory(Path.Combine(scenario.Layout.Apps, Build));
        File.WriteAllText(Path.Combine(scenario.Layout.Apps, Build, "conflict.txt"), "conflict");
        AutoUpdateResult result = await scenario.ExecuteAsync().ConfigureAwait(false);
        Need(result.Status == "failed" && result.Error?.Code == "install-failed" && result.Error.Stage == "install-app", "conflicting app final fails install");
        scenario.AssertOldActive();
        scenario.AssertClean(noJournal: true);
    }

    private static async Task SmokeNonzero(string parent, string fakeAppDirectory)
    {
        await using Scenario scenario = await Scenario.CreateAsync(parent, "08-smoke", fakeAppDirectory).ConfigureAwait(false);
        scenario.SeedOldActive();
        AutoUpdateResult result = await WithEnvironmentAsync("MAGICPOT_TEST_SMOKE_MODE", "nonzero", () => scenario.ExecuteAsync()).ConfigureAwait(false);
        Need(result.Status == "failed" && result.Error?.Code == "smoke-failed" && result.Error.Stage == "smoke", "FakeApp nonzero fails smoke");
        scenario.AssertOldActive();
        scenario.AssertClean(noJournal: true);
    }

    private static async Task CrossReleaseRuntime(string parent, string fakeAppDirectory)
    {
        await using Scenario scenario = await Scenario.CreateAsync(parent, "09-cross-release", fakeAppDirectory, crossReleaseRuntime: true).ConfigureAwait(false);
        scenario.SeedOldActive();
        Need(!ReferenceEquals(scenario.Candidate.Release.Artifacts.Runtime, scenario.Candidate.Runtime), "candidate runtime selected from older release");
        Need(scenario.Candidate.App.RuntimeId == scenario.Candidate.Runtime.RuntimeId, "cross-release runtime satisfies new app");
        AutoUpdateResult result = await scenario.ExecuteAsync().ConfigureAwait(false);
        Need(result.Status == "installed" && result.Version == Version, "cross-release pair installs successfully");
        Need(scenario.ReadActive().ActiveBuildId == Build && scenario.ReadActive().ActiveRuntimeId == Runtime, "cross-release pair becomes active");
        scenario.AssertClean(noJournal: true);
    }

    private static async Task Cancellation(string parent, string fakeAppDirectory)
    {
        await using Scenario scenario = await Scenario.CreateAsync(parent, "10-cancellation", fakeAppDirectory).ConfigureAwait(false);
        scenario.SeedOldActive();
        using var source = new CancellationTokenSource();
        source.Cancel();
        await ThrowsAsync<OperationCanceledException>(() => scenario.ExecuteAsync(cancellationToken: source.Token), "cancellation is rethrown unchanged").ConfigureAwait(false);
        scenario.AssertOldActive();
        scenario.AssertClean(noJournal: true);
    }

    private static async Task StaleActivation(string parent, string fakeAppDirectory)
    {
        var launcher = new CountingLauncher();
        await using Scenario scenario = await Scenario.CreateAsync(parent, "11-stale-activation", fakeAppDirectory, processLauncher: launcher).ConfigureAwait(false);
        scenario.SeedOldActive();
        scenario.Transport.BlockArtifacts();
        Task<AutoUpdateResult> update = scenario.ExecuteAsync();
        Need(scenario.Transport.ArtifactEntered.Wait(TimeSpan.FromSeconds(10)), "stale scenario blocks during download");
        ActivePointerV1 old = scenario.ReadActive();
        ActivePointerV1 winner = new(1, WinnerBuild, OldRuntime, old.ActiveBuildId, old.ActiveRuntimeId, CreatedAt);
        LocalActivationStore.Commit(scenario.Layout, old, winner, DateTimeOffset.Parse(CreatedAt));
        scenario.Transport.ReleaseArtifacts();
        AutoUpdateResult result = await update.ConfigureAwait(false);
        Need(result.Status == "failed" && result.Error?.Code == "stale-activation" && result.Error.Stage == "activate", "stale before smoke reports failed/activate");
        ActivePointerV1 current = scenario.ReadActive();
        Need(current.ActiveBuildId == WinnerBuild && current.ActiveRuntimeId == OldRuntime, "concurrent winner remains active");
        Need(launcher.LaunchCount == 0, "stale transaction does not launch smoke");
        scenario.AssertClean(noJournal: true);
    }

    private static async Task MissingBaseline(string parent, string fakeAppDirectory)
    {
        await using Scenario scenario = await Scenario.CreateAsync(parent, "12-missing-baseline", fakeAppDirectory).ConfigureAwait(false);
        AutoUpdateResult result = await scenario.ExecuteAsync(useCurrentActive: false).ConfigureAwait(false);
        Need(result.Status == "failed" && result.Error?.Code == "active-stale" && result.Error.Stage == "policy", "null currentActive is rejected");
        Need(scenario.Transport.RequestCount == 0, "null currentActive makes zero artifact requests");
        scenario.AssertClean(noJournal: true);
    }

    private static async Task StaleBaselineFiles(string parent, string fakeAppDirectory)
    {
        await using Scenario scenario = await Scenario.CreateAsync(parent, "13-stale-files", fakeAppDirectory).ConfigureAwait(false);
        scenario.SeedOldActive();
        SelectedArtifactsV1 currentActive = scenario.ResolveCurrentArtifacts() ?? throw new InvalidOperationException("old baseline missing");
        File.Delete(Path.Combine(scenario.Layout.Apps, OldBuild, "FakeApp.exe"));
        AutoUpdateResult result = await scenario.ExecuteAsync(currentActiveOverride: currentActive).ConfigureAwait(false);
        Need(result.Status == "failed" && result.Error?.Code == "active-stale" && result.Error.Stage == "resolve", "missing active file is stale baseline");
        Need(scenario.Transport.RequestCount == 0, "stale baseline makes zero artifact requests");
        scenario.AssertClean(noJournal: true);
    }

    private static async Task FinalVerificationRollback(string parent, string fakeAppDirectory)
    {
        await using Scenario scenario = await Scenario.CreateAsync(parent, "14-verify-rollback", fakeAppDirectory).ConfigureAwait(false);
        scenario.SeedOldActive();
        Action<LauncherLayout, ActivePointerV1> corrupt = (layout, _) => File.AppendAllText(Path.Combine(layout.Apps, Build, "FakeApp.exe"), "corrupt");
        AutoUpdateResult result = await scenario.ExecuteAsync(afterActivation: corrupt).ConfigureAwait(false);
        Need(result.Status == "failed" && result.Version == OldVersion && result.Error?.Code == "active-verification-failed" && result.Error.Stage == "verify-active", "final verification failure reports restored old active");
        scenario.AssertOldActive();
        scenario.AssertClean(noJournal: true);
    }

    private static async Task FinalVerificationConcurrentWinner(string parent, string fakeAppDirectory)
    {
        await using Scenario scenario = await Scenario.CreateAsync(parent, "15-verify-winner", fakeAppDirectory).ConfigureAwait(false);
        scenario.SeedOldActive();
        InstallAppTree(scenario.Layout, scenario.FakeAppZip, WinnerBuild, Version, OldRuntime, Commit, CreatedAt);
        Action<LauncherLayout, ActivePointerV1> winner = (layout, candidatePointer) =>
        {
            var winnerPointer = new ActivePointerV1(1, WinnerBuild, OldRuntime, candidatePointer.ActiveBuildId, candidatePointer.ActiveRuntimeId, CreatedAt);
            LocalActivationStore.Commit(layout, candidatePointer, winnerPointer, DateTimeOffset.Parse(CreatedAt));
        };
        AutoUpdateResult result = await scenario.ExecuteAsync(afterActivation: winner).ConfigureAwait(false);
        Need(result.Status == "failed" && result.Version is null && result.Error?.Code == "active-rollback-failed" && result.Error.Stage == "verify-active", "concurrent winner reports rollback not safely confirmed");
        ActivePointerV1 current = scenario.ReadActive();
        Need(current.ActiveBuildId == WinnerBuild && current.ActiveRuntimeId == OldRuntime, "final verification does not overwrite concurrent winner");
        scenario.AssertClean(noJournal: true);
    }

    private sealed class Scenario : IAsyncDisposable
    {
        private Scenario(string root, LauncherLayout layout, FakeTransport transport, ChannelManifestLoadResult manifest, SelectedArtifactsV1 candidate,
            LauncherUpdateConfiguration configuration, byte[] fakeAppZip, byte[] runtimeZip, IProcessLauncher? processLauncher)
        {
            Root = root;
            Layout = layout;
            Transport = transport;
            Manifest = manifest;
            Candidate = candidate;
            Configuration = configuration;
            FakeAppZip = fakeAppZip;
            RuntimeZip = runtimeZip;
            ProcessLauncher = processLauncher;
        }

        internal string Root { get; }
        internal LauncherLayout Layout { get; }
        internal FakeTransport Transport { get; }
        internal ChannelManifestLoadResult Manifest { get; }
        internal SelectedArtifactsV1 Candidate { get; }
        internal LauncherUpdateConfiguration Configuration { get; }
        internal byte[] FakeAppZip { get; }
        internal byte[] RuntimeZip { get; }
        internal IProcessLauncher? ProcessLauncher { get; }

        internal static async Task<Scenario> CreateAsync(string parent, string name, string fakeAppDirectory, byte[]? appBytesOverride = null,
            string? appDigestOverride = null, bool crossReleaseRuntime = false, IProcessLauncher? processLauncher = null)
        {
            string root = Path.Combine(parent, name);
            Directory.CreateDirectory(root);
            LauncherLayout layout = LauncherLayout.Create(root);
            byte[] normalApp = MakeAppZip(fakeAppDirectory, Build, Version, Runtime, Commit, CreatedAt);
            byte[] appBytes = appBytesOverride ?? normalApp;
            byte[] runtimeBytes = MakeRuntimeZip(Runtime, CreatedAt);
            string raw = SignManifest(appBytes, runtimeBytes, appDigestOverride, crossReleaseRuntime);
            var transport = new FakeTransport(new Dictionary<string, byte[]>(StringComparer.Ordinal)
            {
                [ManifestUrl] = Encoding.UTF8.GetBytes(raw),
                [AppUrl] = appBytes,
                [RuntimeUrl] = runtimeBytes
            });
            var key = new Ed25519PrivateKeyParameters(PrivateKey, 0);
            var verifier = new Ed25519ChannelManifestSignatureVerifier(new Dictionary<string, byte[]> { [KeyId] = key.GeneratePublicKey().GetEncoded() });
            TrustedReleaseSource[] trusted = { new(Origin, "/owner/repo/") };
            ChannelManifestLoadResult loaded;
            using (var client = new ChannelManifestClient(new ChannelManifestClientOptions
            {
                Url = ManifestUrl,
                Channel = Channel,
                StateRoot = Path.Combine(root, "manifest-state"),
                SignatureVerifier = verifier,
                TrustedSources = trusted
            }, transport))
            {
                loaded = await client.LoadAsync().ConfigureAwait(false);
            }
            Need(loaded.Source == "network", name + " loads real signed proof");
            SelectedArtifactsV1 candidate = loaded.Proof.SelectLatestArtifacts() ?? throw new InvalidOperationException("candidate selection missing");
            transport.ResetCount();
            var configuration = new LauncherUpdateConfiguration(true, "9.0.0",
                new Dictionary<string, string>(StringComparer.Ordinal) { [Channel] = ManifestUrl }, trusted,
                new Dictionary<string, byte[]>(StringComparer.Ordinal) { [KeyId] = key.GeneratePublicKey().GetEncoded() });
            return new Scenario(root, layout, transport, loaded, candidate, configuration, normalApp, runtimeBytes, processLauncher);
        }

        internal Task<AutoUpdateResult> ExecuteAsync(string mode = "auto-on-launch", CancellationToken cancellationToken = default, SelectedArtifactsV1? candidate = null,
            bool useCurrentActive = true, Action<LauncherLayout, ActivePointerV1>? afterActivation = null, SelectedArtifactsV1? currentActiveOverride = null)
        {
            var options = new AutoUpdateCoordinatorOptions
            {
                DownloaderFactory = (layout, configuration) => new ArtifactDownloader(new ArtifactDownloadOptions
                {
                    StateRoot = Path.Combine(layout.Root, "download-state"),
                    TrustedSources = configuration.TrustedSources,
                    LockTimeout = TimeSpan.FromSeconds(10),
                    LockRetryDelay = TimeSpan.FromMilliseconds(10)
                }, Transport),
                PreparerFactory = layout => new ArtifactPreparer(new ArtifactPreparationOptions { StateRoot = Path.Combine(layout.Root, "prepare-state") }),
                InstallerFactory = layout => new PreparedArtifactInstaller(new PreparedArtifactInstallerOptions
                {
                    Root = layout.Root,
                    LockTimeout = TimeSpan.FromSeconds(10),
                    LockRetryDelay = TimeSpan.FromMilliseconds(10)
                }),
                ActivationFactory = layout => new LocalSmokeActivationTransaction(layout, ProcessLauncher is null
                    ? new LocalSmokeActivationOptions { Timeout = TimeSpan.FromSeconds(10) }
                    : new LocalSmokeActivationOptions { Timeout = TimeSpan.FromSeconds(10), ProcessLauncher = ProcessLauncher }),
                AfterActivation = afterActivation
            };
            var settings = new LauncherSettingsV1(1, mode, Channel, 3, 3, false);
            SelectedArtifactsV1? currentActive = currentActiveOverride ?? (useCurrentActive ? ResolveCurrentArtifacts() : null);
            return new AutoUpdateCoordinator(options).ExecuteAsync(Layout, settings, Configuration, Manifest, candidate ?? Candidate, currentActive, cancellationToken);
        }

        internal void SeedOldActive()
        {
            InstallAppTree(Layout, FakeAppZip, OldBuild, OldVersion, OldRuntime, OldCommit, OldCreatedAt);
            InstallRuntimeTree(Layout, OldRuntime, OldCreatedAt);
            AtomicJson.Write(Layout.ActivePointer, new ActivePointerV1(1, OldBuild, OldRuntime, null, null, OldCreatedAt));
        }

        internal void SeedCandidateActive()
        {
            InstallAppTree(Layout, FakeAppZip, Build, Version, Runtime, Commit, CreatedAt);
            InstallRuntimeTree(Layout, Runtime, CreatedAt);
            AtomicJson.Write(Layout.ActivePointer, new ActivePointerV1(1, Build, Runtime, null, null, CreatedAt));
        }

        internal SelectedArtifactsV1? ResolveCurrentArtifacts()
        {
            ActivePointerV1? pointer = LocalActivationStore.ReadCurrent(Layout);
            if (pointer is null) return null;
            if (pointer.ActiveBuildId == Build && pointer.ActiveRuntimeId == Runtime) return Candidate;
            AppArtifactV1 app = Candidate.App with { Version = OldVersion, BuildId = pointer.ActiveBuildId, RuntimeId = pointer.ActiveRuntimeId };
            RuntimeArtifactV1 runtime = Candidate.Runtime with { RuntimeId = pointer.ActiveRuntimeId };
            return Candidate with { App = app, Runtime = runtime };
        }

        internal ActivePointerV1 ReadActive() => LocalActivationStore.ReadCurrent(Layout) ?? throw new InvalidOperationException("active pointer missing");

        internal void AssertOldActive()
        {
            ActivePointerV1 active = ReadActive();
            Need(active.ActiveBuildId == OldBuild && active.ActiveRuntimeId == OldRuntime, "old active pair is preserved");
        }

        internal void AssertClean(bool noJournal)
        {
            BackgroundPreparedCleanupRegistry.RunOnePass();
            InstallerCleanupRegistry.RunOnePass();
            Need(BackgroundPreparedCleanupRegistry.PendingCount == 0, "prepared cleanup registry is empty");
            Need(InstallerCleanupRegistry.PendingCount == 0, "installer cleanup registry is empty");
            Need(!HasPartialEntriesWithRetry(), "disposed resources leave no partial tree; preparedPending=" + BackgroundPreparedCleanupRegistry.PendingCount + ", installerPending=" + InstallerCleanupRegistry.PendingCount);
            Need(!noJournal || !File.Exists(Layout.ActivationJournal), "activation journal follows completed/aborted rule");
        }

        internal void AssertStateTreeUnoccupied(string relativePath, string label)
        {
            string stateRoot = Path.Combine(Layout.Root, relativePath);
            foreach (string path in Directory.Exists(stateRoot)
                ? Directory.EnumerateFiles(stateRoot, "*", SearchOption.AllDirectories)
                : Array.Empty<string>())
            {
                try
                {
                    using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.None);
                }
                catch (IOException error)
                {
                    throw new InvalidOperationException("Self-test assertion failed: " + label + "; occupied=" + path, error);
                }
            }
            assertions++;
        }

        private bool HasPartialEntriesWithRetry()
        {
            var elapsed = Stopwatch.StartNew();
            while (true)
            {
                try
                {
                    return Directory.EnumerateFileSystemEntries(Root, "*.partial-*", SearchOption.AllDirectories).Any();
                }
                catch (IOException) when (elapsed.Elapsed < TimeSpan.FromSeconds(1))
                {
                    Thread.Sleep(25);
                }
                catch (UnauthorizedAccessException) when (elapsed.Elapsed < TimeSpan.FromSeconds(1))
                {
                    Thread.Sleep(25);
                }
                catch (IOException)
                {
                    return true;
                }
                catch (UnauthorizedAccessException)
                {
                    return true;
                }
            }
        }

        public ValueTask DisposeAsync()
        {
            Transport.Dispose();
            return ValueTask.CompletedTask;
        }
    }

    private sealed class FakeTransport : IChannelManifestTransport
    {
        private readonly IReadOnlyDictionary<string, byte[]> bodies;
        private readonly Dictionary<string, Exception> exceptions = new(StringComparer.Ordinal);
        private readonly ManualResetEventSlim artifactRelease = new(true);
        private int requestCount;

        internal FakeTransport(IReadOnlyDictionary<string, byte[]> bodies) => this.bodies = bodies;
        internal int RequestCount => Volatile.Read(ref requestCount);
        internal ManualResetEventSlim ArtifactEntered { get; } = new(false);
        internal void ResetCount() => Interlocked.Exchange(ref requestCount, 0);
        internal void SetException(string url, Exception exception) => exceptions[url] = exception;
        internal void BlockArtifacts() { ArtifactEntered.Reset(); artifactRelease.Reset(); }
        internal void ReleaseArtifacts() => artifactRelease.Set();

        public async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Interlocked.Increment(ref requestCount);
            string url = request.RequestUri?.AbsoluteUri ?? throw new InvalidOperationException("request URL missing");
            if (url == AppUrl || url == RuntimeUrl)
            {
                ArtifactEntered.Set();
                await Task.Run(() => artifactRelease.Wait(cancellationToken), cancellationToken).ConfigureAwait(false);
            }
            if (exceptions.TryGetValue(url, out Exception? error)) throw error;
            if (!bodies.TryGetValue(url, out byte[]? body)) return new HttpResponseMessage(HttpStatusCode.NotFound) { RequestMessage = request };
            var response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                RequestMessage = new HttpRequestMessage(request.Method, url),
                Content = new ByteArrayContent(body)
            };
            response.Content.Headers.ContentLength = body.Length;
            return response;
        }

        public void Dispose() { artifactRelease.Dispose(); ArtifactEntered.Dispose(); }
    }

    private sealed class CountingLauncher : IProcessLauncher
    {
        private int launchCount;
        internal int LaunchCount => Volatile.Read(ref launchCount);

        public SmokeProcessResult Launch(InstalledArtifactReceipt appReceipt, InstalledArtifactReceipt runtimeReceipt, SmokeProcessRequest request)
        {
            Interlocked.Increment(ref launchCount);
            return new SmokeProcessResult(0, false, "{\"ok\":true,\"version\":\"" + Version + "\",\"buildId\":\"" + Build + "\"}\n", string.Empty, false, false);
        }
    }

    private static string SignManifest(byte[] appZip, byte[] runtimeZip, string? appDigestOverride, bool crossReleaseRuntime)
    {
        long appUnpacked = TryReadUnpackedSize(appZip);
        long runtimeUnpacked = ReadUnpackedSize(runtimeZip);
        var app = new AppArtifactV1("app", Version, Build, Commit, Runtime, "win32", "x64", AppUrl,
            appDigestOverride ?? Hash(appZip), appZip.Length, appUnpacked, "FakeApp.exe", CreatedAt);
        var runtime = new RuntimeArtifactV1("runtime", Runtime, "win32", "x64", RuntimeUrl, Hash(runtimeZip), runtimeZip.Length,
            runtimeUnpacked, "python/python.exe", CreatedAt);
        var releases = new List<ChannelReleaseV1>();
        if (crossReleaseRuntime)
        {
            var oldAppBytes = Encoding.UTF8.GetBytes("unused old app");
            var oldApp = new AppArtifactV1("app", "1.5.0", "20250101-130405-abcdef0", OldCommit, Runtime, "win32", "x64",
                Origin + "/owner/repo/releases/download/v15/app.zip", Hash(oldAppBytes), oldAppBytes.Length, oldAppBytes.Length, "unused.exe", OldCreatedAt);
            releases.Add(new ChannelReleaseV1("1.5.0", oldApp.BuildId, oldApp.CommitSha, OldCreatedAt,
                Origin + "/owner/repo/releases/tag/v15", "1.0.0", new ReleaseArtifactsV1(oldApp, runtime)));
            releases.Add(new ChannelReleaseV1(Version, Build, Commit, CreatedAt, Origin + "/owner/repo/releases/tag/v2", "1.0.0", new ReleaseArtifactsV1(app, null)));
        }
        else
        {
            releases.Add(new ChannelReleaseV1(Version, Build, Commit, CreatedAt, Origin + "/owner/repo/releases/tag/v2", "1.0.0", new ReleaseArtifactsV1(app, runtime)));
        }

        var unsigned = new ChannelManifestV1(1, Channel, CreatedAt, releases,
            new ManifestSignatureV1("ed25519", KeyId, Convert.ToBase64String(new byte[64])));
        byte[] payload = OfflineUpdateDecision.SigningPayload(unsigned);
        var signer = new Ed25519Signer();
        signer.Init(true, new Ed25519PrivateKeyParameters(PrivateKey, 0));
        signer.BlockUpdate(payload, 0, payload.Length);
        ChannelManifestV1 signed = unsigned with { Signature = new ManifestSignatureV1("ed25519", KeyId, Convert.ToBase64String(signer.GenerateSignature())) };
        return JsonSerializer.Serialize(signed, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull });
    }

    private static byte[] MakeAppZip(string fakeAppDirectory, string build, string version, string runtime, string commit, string createdAt)
    {
        RequireFakeApp(fakeAppDirectory);
        var payload = Directory.EnumerateFiles(fakeAppDirectory)
            .Where(static path => Path.GetFileName(path).StartsWith("FakeApp", StringComparison.OrdinalIgnoreCase))
            .ToDictionary(static path => Path.GetFileName(path), File.ReadAllBytes, StringComparer.OrdinalIgnoreCase);
        return MakeZip(payload, files => new InstalledAppManifestV1(1, "magicpot-app", version, build, commit, "win32", "x64", runtime,
            "FakeApp.exe", createdAt, payload.Values.Sum(static bytes => (long)bytes.Length), files));
    }

    private static byte[] MakeRuntimeZip(string runtime, string createdAt)
    {
        var payload = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase)
        {
            ["python/python.exe"] = Encoding.UTF8.GetBytes("runtime-python"),
            ["comfy/main.py"] = Encoding.UTF8.GetBytes("print('smoke')")
        };
        return MakeZip(payload, files => new InstalledRuntimeManifestV1(1, "magicpot-runtime", runtime, "win32", "x64", createdAt,
            new RuntimeEntrypointsV1("python/python.exe", "comfy/main.py"), payload.Values.Sum(static bytes => (long)bytes.Length), files));
    }

    private static byte[] MakeZip(IReadOnlyDictionary<string, byte[]> payload, Func<IReadOnlyList<InstalledFileV1>, object> manifestFactory)
    {
        IReadOnlyList<InstalledFileV1> files = payload.Select(static pair => new InstalledFileV1(pair.Key, pair.Value.Length, Hash(pair.Value))).ToArray();
        byte[] manifest = Encoding.UTF8.GetBytes(Protocol.Serialize(manifestFactory(files)));
        using var output = new MemoryStream();
        using (var archive = new ZipArchive(output, ZipArchiveMode.Create, true, Encoding.UTF8))
        {
            foreach (KeyValuePair<string, byte[]> pair in payload)
            {
                ZipArchiveEntry entry = archive.CreateEntry(pair.Key, CompressionLevel.NoCompression);
                entry.ExternalAttributes = 0x20;
                using Stream stream = entry.Open();
                stream.Write(pair.Value);
            }
            ZipArchiveEntry manifestEntry = archive.CreateEntry("manifest.json", CompressionLevel.NoCompression);
            manifestEntry.ExternalAttributes = 0x20;
            using Stream manifestStream = manifestEntry.Open();
            manifestStream.Write(manifest);
        }
        return output.ToArray();
    }

    private static void InstallAppTree(LauncherLayout layout, byte[] candidateZip, string build, string version, string runtime, string commit, string createdAt)
    {
        Dictionary<string, byte[]> payload = ReadPayload(candidateZip);
        payload.Remove("manifest.json");
        IReadOnlyList<InstalledFileV1> files = payload.Select(static pair => new InstalledFileV1(pair.Key, pair.Value.Length, Hash(pair.Value))).ToArray();
        var manifest = new InstalledAppManifestV1(1, "magicpot-app", version, build, commit, "win32", "x64", runtime, "FakeApp.exe", createdAt,
            payload.Values.Sum(static bytes => (long)bytes.Length), files);
        WriteInstalledTree(Path.Combine(layout.Apps, build), payload, Protocol.Serialize(manifest));
    }

    private static void InstallRuntimeTree(LauncherLayout layout, string runtime, string createdAt)
    {
        var payload = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase)
        {
            ["python/python.exe"] = Encoding.UTF8.GetBytes("runtime-python"),
            ["comfy/main.py"] = Encoding.UTF8.GetBytes("print('smoke')")
        };
        IReadOnlyList<InstalledFileV1> files = payload.Select(static pair => new InstalledFileV1(pair.Key, pair.Value.Length, Hash(pair.Value))).ToArray();
        var manifest = new InstalledRuntimeManifestV1(1, "magicpot-runtime", runtime, "win32", "x64", createdAt,
            new RuntimeEntrypointsV1("python/python.exe", "comfy/main.py"), payload.Values.Sum(static bytes => (long)bytes.Length), files);
        WriteInstalledTree(Path.Combine(layout.Runtimes, runtime), payload, Protocol.Serialize(manifest));
    }

    private static Dictionary<string, byte[]> ReadPayload(byte[] zip)
    {
        using var input = new MemoryStream(zip);
        using var archive = new ZipArchive(input, ZipArchiveMode.Read, false, Encoding.UTF8);
        return archive.Entries.Where(static entry => !string.IsNullOrEmpty(entry.Name)).ToDictionary(entry => entry.FullName, entry =>
        {
            using Stream stream = entry.Open();
            using var output = new MemoryStream();
            stream.CopyTo(output);
            return output.ToArray();
        }, StringComparer.OrdinalIgnoreCase);
    }

    private static void WriteInstalledTree(string directory, IReadOnlyDictionary<string, byte[]> payload, string manifest)
    {
        Directory.CreateDirectory(directory);
        foreach (KeyValuePair<string, byte[]> pair in payload)
        {
            string path = Path.Combine(directory, pair.Key.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllBytes(path, pair.Value);
        }
        File.WriteAllText(Path.Combine(directory, "manifest.json"), manifest, new UTF8Encoding(false));
    }

    private static long TryReadUnpackedSize(byte[] bytes)
    {
        try { return ReadUnpackedSize(bytes); }
        catch (InvalidDataException) { return bytes.Length; }
    }

    private static long ReadUnpackedSize(byte[] bytes)
    {
        using var input = new MemoryStream(bytes);
        using var archive = new ZipArchive(input, ZipArchiveMode.Read, false, Encoding.UTF8);
        return archive.Entries.Sum(static entry => entry.Length);
    }

    private static void RequireFakeApp(string directory)
    {
        foreach (string file in new[] { "FakeApp.exe", "FakeApp.dll", "FakeApp.runtimeconfig.json" })
            if (!File.Exists(Path.Combine(directory, file))) throw new InvalidOperationException("MAGICPOT_FAKE_APP_DIR is incomplete: " + file);
    }

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static async Task<T> WithEnvironmentAsync<T>(string name, string value, Func<Task<T>> action)
    {
        string? previous = Environment.GetEnvironmentVariable(name);
        try
        {
            Environment.SetEnvironmentVariable(name, value);
            return await action().ConfigureAwait(false);
        }
        finally
        {
            Environment.SetEnvironmentVariable(name, previous);
        }
    }

    private static async Task ThrowsAsync<T>(Func<Task> action, string label) where T : Exception
    {
        try { await action().ConfigureAwait(false); }
        catch (T) { assertions++; return; }
        throw new InvalidOperationException("Expected " + typeof(T).Name + ": " + label);
    }

    private static void Need(bool condition, string label)
    {
        assertions++;
        if (!condition) throw new InvalidOperationException("Self-test assertion failed: " + label);
    }

    private static void TryDelete(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, true); }
        catch { }
    }
}
