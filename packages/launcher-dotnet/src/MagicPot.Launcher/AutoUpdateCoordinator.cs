using System.Diagnostics;
using System.Runtime.ExceptionServices;

namespace MagicPot.Launcher;

internal sealed record AutoUpdateError(string Code, string Stage, string Message);
internal sealed record AutoUpdateResult(string Status, string? Version, AutoUpdateError? Error)
{
    internal static AutoUpdateResult Installed(string version) => new("installed", version, null);
    internal static AutoUpdateResult UpToDate(string version) => new("up-to-date", version, null);
    internal static AutoUpdateResult Failed(string? version, string code, string stage, string message) => new("failed", version, new(code, stage, message));
    internal static AutoUpdateResult Unavailable(string version) => new("unavailable", version, new("transport-unavailable", "download", "The artifact transport is unavailable."));
}

internal sealed class AutoUpdateCoordinatorOptions
{
    internal Func<LauncherLayout, LauncherUpdateConfiguration, ArtifactDownloader>? DownloaderFactory { get; init; }
    internal Func<LauncherLayout, ArtifactPreparer>? PreparerFactory { get; init; }
    internal Func<LauncherLayout, PreparedArtifactInstaller>? InstallerFactory { get; init; }
    internal Func<LauncherLayout, LocalSmokeActivationTransaction>? ActivationFactory { get; init; }
    internal Func<LauncherLayout, InstalledSelectionResolver>? SelectionResolverFactory { get; init; }
    internal Action<LauncherLayout, ActivePointerV1>? AfterActivation { get; init; }
    internal Func<DateTimeOffset>? Clock { get; init; }
}

internal interface IAutoUpdateCoordinator
{
    Task<AutoUpdateResult> ExecuteAsync(LauncherLayout layout, LauncherSettingsV1 settings, LauncherUpdateConfiguration configuration,
        ChannelManifestLoadResult manifest, SelectedArtifactsV1 candidate, SelectedArtifactsV1? currentActive = null, CancellationToken cancellationToken = default);
}

internal interface IAutoUpdateCoordinatorFactory
{
    IAutoUpdateCoordinator Create();
}

internal sealed class DefaultAutoUpdateCoordinatorFactory : IAutoUpdateCoordinatorFactory
{
    public IAutoUpdateCoordinator Create() => new AutoUpdateCoordinator();
}

internal sealed class AutoUpdateCoordinator : IAutoUpdateCoordinator
{
    private readonly AutoUpdateCoordinatorOptions options;
    internal AutoUpdateCoordinator(AutoUpdateCoordinatorOptions? options = null) => this.options = options ?? new();

    public async Task<AutoUpdateResult> ExecuteAsync(LauncherLayout layout, LauncherSettingsV1 settings, LauncherUpdateConfiguration configuration,
        ChannelManifestLoadResult manifest, SelectedArtifactsV1 candidate, SelectedArtifactsV1? currentActive = null, CancellationToken cancellationToken = default)
    {
        try
        {
            return await RunCoreAsync(layout, settings, configuration, manifest, candidate, currentActive, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            DrainCleanupRegistries();
        }
    }

    private async Task<AutoUpdateResult> RunCoreAsync(LauncherLayout layout, LauncherSettingsV1 settings, LauncherUpdateConfiguration configuration,
        ChannelManifestLoadResult manifest, SelectedArtifactsV1 candidate, SelectedArtifactsV1? currentActive, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(layout); ArgumentNullException.ThrowIfNull(settings); ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(manifest); ArgumentNullException.ThrowIfNull(candidate);
        if (settings.UpdateMode != "auto-on-launch") return AutoUpdateResult.Failed(null, "mode-not-auto", "policy", "Automatic installation is not enabled.");
        if (!configuration.Enabled || settings.Channel != manifest.Proof.Channel || !configuration.ChannelUrls.ContainsKey(settings.Channel))
            return AutoUpdateResult.Failed(null, "update-disabled", "policy", "Automatic installation is not enabled for the selected channel.");
        if (currentActive is null)
            return AutoUpdateResult.Failed(null, "active-stale", "policy", "Automatic update requires an existing verified active installation.");

        VerifiedArtifactRequest appRequest, runtimeRequest;
        string version;
        try
        {
            appRequest = manifest.Proof.CreateAppRequest(candidate);
            runtimeRequest = manifest.Proof.CreateRuntimeRequest(candidate);
            version = ((AppArtifactV1)appRequest.Artifact).Version;
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            Trace(error);
            return AutoUpdateResult.Failed(null, "candidate-not-capable", "capability", "The update candidate is not bound to the verified manifest.");
        }

        InstalledSelectionResolver resolver = (options.SelectionResolverFactory ?? (static x => new InstalledSelectionResolver(x)))(layout);
        InstalledSelection? baseline;
        try { baseline = resolver.ResolveActive(); }
        catch (Exception error) when (error is not OperationCanceledException) { Trace(error); return AutoUpdateResult.Failed(version, "active-read-failed", "resolve", "The active installation could not be resolved."); }
        if (baseline is null || !Matches(baseline, currentActive))
            return AutoUpdateResult.Failed(version, "active-stale", "resolve", "The active installation changed before the update started.");
        ActivePointerV1 before = baseline.Pointer;
        if (before.ActiveBuildId == candidate.App.BuildId && before.ActiveRuntimeId == candidate.Runtime.RuntimeId) return AutoUpdateResult.UpToDate(version);

        using ArtifactDownloader downloader = (options.DownloaderFactory ?? DefaultDownloader)(layout, configuration);
        ArtifactPreparer preparer = (options.PreparerFactory ?? (static x => new ArtifactPreparer(new ArtifactPreparationOptions { StateRoot = x.Root })))(layout);
        PreparedArtifactInstaller installer = (options.InstallerFactory ?? (static x => new PreparedArtifactInstaller(new PreparedArtifactInstallerOptions { Root = x.Root })))(layout);
        LocalSmokeActivationTransaction activation = (options.ActivationFactory ?? (static x => new LocalSmokeActivationTransaction(x)))(layout);
        VerifiedArtifactLease? ad = null, rd = null; PreparedArtifactLease? ap = null, rp = null;
        PreparedArtifactPackage? app = null, runtime = null; InstalledArtifactReceipt? ar = null, rr = null;
        ActivationReceipt? activationReceipt = null;
        string stage = "download";
        try
        {
            (ad, rd) = await AwaitOwnedPairAsync(
                token => downloader.DownloadAsync(appRequest, token),
                token => downloader.DownloadAsync(runtimeRequest, token),
                cancellationToken).ConfigureAwait(false);
            stage = "prepare";
            (ap, rp) = await AwaitOwnedPairAsync(
                token => preparer.PrepareAsync(ad, token),
                token => preparer.PrepareAsync(rd, token),
                cancellationToken).ConfigureAwait(false);
            await ad.DisposeAsync().ConfigureAwait(false); ad = null; await rd.DisposeAsync().ConfigureAwait(false); rd = null;
            EnsureBinding(ap, rp, manifest.Proof, candidate); app = ap.TakeOwnership(); ap = null; runtime = rp.TakeOwnership(); rp = null;
            stage = "install-runtime"; rr = await installer.InstallAsync(runtime, cancellationToken).ConfigureAwait(false); await runtime.DisposeAsync().ConfigureAwait(false); runtime = null;
            stage = "install-app"; ar = await installer.InstallAsync(app, cancellationToken).ConfigureAwait(false); await app.DisposeAsync().ConfigureAwait(false); app = null;
            cancellationToken.ThrowIfCancellationRequested(); stage = "smoke"; activationReceipt = activation.Execute(ar!, rr!, before); stage = "verify-active";
            options.AfterActivation?.Invoke(layout, activationReceipt.Current);
            InstalledSelection? resolved = resolver.ResolveActive();
            if (resolved is null || !LocalActivationStore.Same(resolved.Pointer, activationReceipt.Current) || !Matches(resolved, candidate)) throw new AutoUpdateVerificationException();
            return AutoUpdateResult.Installed(version);
        }
        catch (OperationCanceledException) { throw; }
        catch (ArtifactTransportException error) { Trace(error); return AutoUpdateResult.Unavailable(version); }
        catch (Exception error)
        {
            Trace(error); if (error is StaleActivationException) stage = "activate";
            if (stage == "verify-active" && activationReceipt is not null)
                return VerifyActiveFailure(layout, resolver, before, activationReceipt.Current, currentActive.App.Version);
            if (stage is "smoke" or "activate" or "verify-active") RecoverBestEffort(layout, resolver, before, candidate);
            return AutoUpdateResult.Failed(version, Code(stage, error), stage, Message(stage));
        }
        finally
        {
            if (ar is not null) await ar.DisposeAsync().ConfigureAwait(false); if (rr is not null) await rr.DisposeAsync().ConfigureAwait(false);
            if (app is not null) await app.DisposeAsync().ConfigureAwait(false); if (runtime is not null) await runtime.DisposeAsync().ConfigureAwait(false);
            if (ap is not null) await ap.DisposeAsync().ConfigureAwait(false); if (rp is not null) await rp.DisposeAsync().ConfigureAwait(false);
            if (ad is not null) await ad.DisposeAsync().ConfigureAwait(false); if (rd is not null) await rd.DisposeAsync().ConfigureAwait(false);
        }
    }

    private static void DrainCleanupRegistries()
    {
        var elapsed = Stopwatch.StartNew();
        for (int pass = 0; pass < 20 && elapsed.ElapsedMilliseconds < 500; pass++)
        {
            BackgroundPreparedCleanupRegistry.RunOnePass();
            InstallerCleanupRegistry.RunOnePass();
            int prepared = BackgroundPreparedCleanupRegistry.PendingCount;
            int installed = InstallerCleanupRegistry.PendingCount;
            if (prepared == 0 && installed == 0) return;

            int remainingMilliseconds = 500 - (int)elapsed.ElapsedMilliseconds;
            if (pass < 19 && remainingMilliseconds > 0) Thread.Sleep(Math.Min(25, remainingMilliseconds));
        }

        Trace(new InvalidOperationException($"Cleanup remains pending after bounded drain: prepared={BackgroundPreparedCleanupRegistry.PendingCount}, installer={InstallerCleanupRegistry.PendingCount}."));
    }

    private static ArtifactDownloader DefaultDownloader(LauncherLayout l, LauncherUpdateConfiguration c) => new(new ArtifactDownloadOptions { StateRoot = l.Root, TrustedSources = c.TrustedSources });

    private static async Task<(T First, T Second)> AwaitOwnedPairAsync<T>(Func<CancellationToken, Task<T>> startFirst,
        Func<CancellationToken, Task<T>> startSecond, CancellationToken cancellationToken) where T : IAsyncDisposable
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        Task<T> first = startFirst(linked.Token);
        Task<T> second = startSecond(linked.Token);
        CancelPeerOnFailure(first, linked);
        CancelPeerOnFailure(second, linked);
        try
        {
            await Task.WhenAll(first, second).ConfigureAwait(false);
            return (await first.ConfigureAwait(false), await second.ConfigureAwait(false));
        }
        catch (Exception original)
        {
            linked.Cancel();
            await Task.WhenAll(DisposeSuccessfulResultAsync(first), DisposeSuccessfulResultAsync(second)).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            ExceptionDispatchInfo.Capture(original).Throw();
            throw;
        }
    }

    private static void CancelPeerOnFailure(Task task, CancellationTokenSource linked)
    {
        _ = task.ContinueWith(static (_, state) =>
        {
            try { ((CancellationTokenSource)state!).Cancel(); }
            catch (ObjectDisposedException) { }
        }, linked, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously | TaskContinuationOptions.NotOnRanToCompletion, TaskScheduler.Default);
    }

    private static async Task DisposeSuccessfulResultAsync<T>(Task<T> task) where T : IAsyncDisposable
    {
        try { await task.ConfigureAwait(false); }
        catch { }
        if (task.Status != TaskStatus.RanToCompletion) return;
        T result = await task.ConfigureAwait(false);
        try { await result.DisposeAsync().ConfigureAwait(false); }
        catch (Exception error) { Trace(error); }
    }

    private static void EnsureBinding(PreparedArtifactLease app, PreparedArtifactLease runtime, VerifiedChannelManifestProof proof, SelectedArtifactsV1 candidate)
    {
        string key = proof.RawManifestSha256 + "\n" + proof.SigningPayloadSha256 + "\n" + proof.SignatureKeyId + "\n" + proof.VerifierIdentity;
        if (app.Kind != "app" || runtime.Kind != "runtime" || app.Identity.ProofKey() != key || runtime.Identity.ProofKey() != key || app.Identity.BuildId != candidate.App.BuildId || app.Identity.RuntimeId != candidate.Runtime.RuntimeId || runtime.Identity.RuntimeId != candidate.Runtime.RuntimeId) throw new OfflineUpdateException("Prepared artifacts are not bound to the candidate proof.");
    }
    private static void RecoverBestEffort(LauncherLayout layout, InstalledSelectionResolver resolver, ActivePointerV1? before, SelectedArtifactsV1 candidate)
    {
        try { LocalActivationStore.Recover(layout); } catch (Exception e) { Trace(e); }
        try { ActivePointerV1? p = resolver.ResolveActive()?.Pointer; bool oldPair = before is not null && p is not null && p.ActiveBuildId == before.ActiveBuildId && p.ActiveRuntimeId == before.ActiveRuntimeId; bool newPair = p is not null && p.ActiveBuildId == candidate.App.BuildId && p.ActiveRuntimeId == candidate.Runtime.RuntimeId; if (!oldPair && !newPair) Trace(new InvalidOperationException("Unexpected recovered pair.")); } catch (Exception e) { Trace(e); }
    }
    private AutoUpdateResult VerifyActiveFailure(LauncherLayout layout, InstalledSelectionResolver resolver, ActivePointerV1 before,
        ActivePointerV1 candidatePointer, string previousVersion)
    {
        try
        {
            ActivePointerV1? actual = LocalActivationStore.RecoverAndReadCurrent(layout);
            if (LocalActivationStore.Same(actual, candidatePointer))
            {
                LocalActivationStore.Commit(layout, candidatePointer, before, (options.Clock ?? (static () => DateTimeOffset.UtcNow))());
                actual = LocalActivationStore.RecoverAndReadCurrent(layout);
            }
            if (!LocalActivationStore.Same(actual, before))
                return AutoUpdateResult.Failed(null, "active-rollback-failed", "verify-active", "The activated installation failed verification and its active state could not be safely confirmed.");
            InstalledSelection? restored = resolver.ResolveActive();
            if (restored is null || !LocalActivationStore.Same(restored.Pointer, before) || !MatchesPair(restored, before.ActiveBuildId, before.ActiveRuntimeId))
                return AutoUpdateResult.Failed(null, "active-rollback-failed", "verify-active", "The activated installation failed verification and its active state could not be safely confirmed.");
            return AutoUpdateResult.Failed(previousVersion, "active-verification-failed", "verify-active", "The activated installation failed verification; the previous active installation was restored.");
        }
        catch (Exception rollbackError) when (rollbackError is not OperationCanceledException)
        {
            Trace(rollbackError);
            return AutoUpdateResult.Failed(null, "active-rollback-failed", "verify-active", "The activated installation failed verification and its active state could not be safely confirmed.");
        }
    }
    private static bool Matches(InstalledSelection selection, SelectedArtifactsV1 expected) =>
        MatchesPair(selection, expected.App.BuildId, expected.Runtime.RuntimeId);
    private static bool MatchesPair(InstalledSelection selection, string buildId, string runtimeId) =>
        selection.Pointer.ActiveBuildId == buildId && selection.Pointer.ActiveRuntimeId == runtimeId &&
        selection.Installation.App.BuildId == buildId && selection.Installation.App.RuntimeId == runtimeId &&
        selection.Installation.Runtime.RuntimeId == runtimeId;
    private static string Code(string stage, Exception error)
    {
        return error switch { AutoUpdateVerificationException => "active-verification-failed", ArtifactDownloaderException => "download-invalid", ArtifactPreparationException => "prepare-failed", PreparedArtifactInstallationException => "install-failed", StaleActivationException => "stale-activation", LocalSmokeActivationException => "smoke-failed", _ => stage + "-failed" };
    }
    private static string Message(string stage) => stage switch { "download" => "Artifact download validation failed.", "prepare" => "Artifact preparation failed.", "install-runtime" => "Runtime installation failed.", "install-app" => "Application installation failed.", "smoke" => "The local smoke test failed.", "activate" => "Activation lost a concurrency race.", "verify-active" => "The activated installation could not be verified.", _ => "The automatic update failed." };
    private static void Trace(Exception error)
    {
        Debug.WriteLine("Auto update detail: " + error);
    }
    private sealed class AutoUpdateVerificationException : Exception;
}

internal static class ArtifactDownloadIdentityExtensions
{
    internal static string ProofKey(this ArtifactDownloadIdentity x) => x.ManifestRawDigest + "\n" + x.SigningPayloadDigest + "\n" + x.SignatureKeyId + "\n" + x.VerifierIdentity;
}
