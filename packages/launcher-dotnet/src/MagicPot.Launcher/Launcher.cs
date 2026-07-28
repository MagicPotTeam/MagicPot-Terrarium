using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace MagicPot.Launcher;

public sealed record LauncherLayout(string Root, string ActivePointer, string ActivationJournal, string Apps, string Runtimes, string Health, string HealthLock, string Log)
{
    public static LauncherLayout Create(string root)
    {
        if (!Path.IsPathFullyQualified(root)) throw new ArgumentException("Launcher root must be absolute");
        root = Path.GetFullPath(root);
        return new(root, Path.Combine(root, "active.json"), Path.Combine(root, "activation-journal.json"), Path.Combine(root, "apps"), Path.Combine(root, "runtimes"), Path.Combine(root, "launcher-health.json"), Path.Combine(root, ".health-lock"), Path.Combine(root, "launcher.log.jsonl"));
    }
}

public sealed record ActivationJournalV1(int Schema, string Phase, string CreatedAt, ActivePointerV1? From, ActivePointerV1 To);
public sealed record UpdateLockOwnerV1(int Schema, string Token, int Pid, string Hostname, string CreatedAt);
public sealed record LaunchFileIdentity(uint VolumeSerialNumber, ulong FileIndex, long Length);
public sealed record ValidatedInstallation(InstalledAppManifestV1 App, InstalledRuntimeManifestV1 Runtime, string AppDirectory, string RuntimeDirectory, string AppEntrypoint, LaunchFileIdentity AppEntrypointIdentity);
public sealed record LaunchSelection(ValidatedInstallation Installation, string Source, ActivePointerV1? Pointer);

public static class LauncherTime
{
    public static string Timestamp(DateTimeOffset value) => value.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
}

public static class AtomicJson
{
    public static void Write<T>(string path, T value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = Path.Combine(Path.GetDirectoryName(path)!, $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 16 * 1024, FileOptions.WriteThrough))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
            {
                writer.Write(Protocol.Serialize(value));
                writer.Flush();
                stream.Flush(true);
            }
            RetrySharing(() => File.Move(temporary, path, true));
        }
        finally
        {
            try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
        }
    }

    public static void Delete(string path) => RetrySharing(() => File.Delete(path));

    private static void RetrySharing(Action action)
    {
        for (var attempt = 0; ; attempt++)
        {
            try { action(); return; }
            catch (IOException) when (attempt < 5) { Thread.Sleep(20 * (attempt + 1)); }
            catch (UnauthorizedAccessException) when (attempt < 5) { Thread.Sleep(20 * (attempt + 1)); }
        }
    }
}

public sealed class UpdateFileLock : IDisposable
{
    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan DefaultRetry = TimeSpan.FromMilliseconds(50);
    public static readonly TimeSpan HealthLockStale = TimeSpan.FromMinutes(10);
    private const string LockFileName = "update.lock";
    private readonly string lockFile;
    private readonly string token;
    private readonly FileStream handle;
    private readonly TimeSpan releaseTimeout;
    private readonly TimeSpan retryDelay;
    private int handleClosed;
    private int released;

    private UpdateFileLock(string lockFile, string token, FileStream handle, TimeSpan releaseTimeout, TimeSpan retryDelay)
    {
        this.lockFile = lockFile; this.token = token; this.handle = handle; this.releaseTimeout = releaseTimeout; this.retryDelay = retryDelay;
    }

    public static UpdateFileLock Acquire(string lockRoot, TimeSpan? timeout = null, TimeSpan? retry = null, TimeSpan? stale = null)
    {
        timeout ??= DefaultTimeout; retry ??= DefaultRetry;
        if (timeout.Value < TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(timeout));
        if (retry.Value <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(retry));
        if (stale is { } staleValue && staleValue < TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(stale));
        lockRoot = Path.GetFullPath(lockRoot);
        Directory.CreateDirectory(lockRoot);
        var lockFile = Path.Combine(lockRoot, LockFileName);
        var started = Stopwatch.StartNew(); var token = Guid.NewGuid().ToString("N");
        while (true)
        {
            try
            {
                var handle = new FileStream(lockFile, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read, 4096, FileOptions.WriteThrough);
                try
                {
                    var owner = new UpdateLockOwnerV1(1, token, Environment.ProcessId, Dns.GetHostName(), LauncherTime.Timestamp(DateTimeOffset.UtcNow));
                    var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(owner, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }) + "\n");
                    handle.Write(bytes); handle.Flush(true);
                    return new UpdateFileLock(lockFile, token, handle, timeout.Value, retry.Value);
                }
                catch { handle.Dispose(); try { File.Delete(lockFile); } catch { } throw; }
            }
            catch (IOException error)
            {
                if (stale is { } staleAfter && TryDeleteStale(lockFile, staleAfter)) continue;
                if (started.Elapsed >= timeout.Value) throw new TimeoutException($"Update lock remained busy for {timeout.Value.TotalMilliseconds:0} ms: {lockFile}", error);
                var remaining = timeout.Value - started.Elapsed;
                if (remaining > TimeSpan.Zero) Thread.Sleep(remaining < retry.Value ? remaining : retry.Value);
            }
        }
    }

    public void Dispose()
    {
        if (Volatile.Read(ref released) != 0) return;
        if (Interlocked.Exchange(ref handleClosed, 1) == 0) handle.Dispose();
        var started = Stopwatch.StartNew();
        while (true)
        {
            UpdateLockOwnerV1? owner;
            try { owner = ReadOwner(lockFile); }
            catch (Exception error) when (IsReleaseSharingError(error) && RetryRelease(started)) { continue; }
            if (owner is null) throw new IOException("Update lock ownership could not be verified before release");
            if (!string.Equals(owner.Token, token, StringComparison.Ordinal)) throw new IOException("Update lock ownership changed before release");
            try
            {
                File.Delete(lockFile);
                Volatile.Write(ref released, 1);
                return;
            }
            catch (Exception error) when (IsReleaseSharingError(error) && RetryRelease(started)) { }
        }
    }

    private bool RetryRelease(Stopwatch started)
    {
        if (started.Elapsed >= releaseTimeout) return false;
        var remaining = releaseTimeout - started.Elapsed;
        if (remaining > TimeSpan.Zero) Thread.Sleep(remaining < retryDelay ? remaining : retryDelay);
        return true;
    }

    private static bool IsReleaseSharingError(Exception error) => error is IOException or UnauthorizedAccessException;

    private static UpdateLockOwnerV1? ReadOwner(string path) => ParseOwner(ReadOwnerText(path));

    internal static string ReadOwnerText(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        return reader.ReadToEnd();
    }

    private static bool TryDeleteStale(string path, TimeSpan stale)
    {
        try
        {
            var before = Snapshot(path);
            if (before is null) return true;
            var owner = ParseOwner(before.Value.Content);
            if (owner is null || DateTimeOffset.UtcNow - ParseCreatedAt(owner.CreatedAt) < stale) return false;
            if (!string.Equals(owner.Hostname, Dns.GetHostName(), StringComparison.OrdinalIgnoreCase)) return false;
            if (IsProcessAlive(owner.Pid)) return false;
            Thread.Sleep(20);
            var after = Snapshot(path);
            if (after is null) return true;
            if (before != after) return false;
            var quarantine = $"{path}.{owner.Token}.{Guid.NewGuid():N}.stale";
            File.Move(path, quarantine);
            var moved = Snapshot(quarantine);
            if (moved != after)
            {
                try { if (!File.Exists(path)) File.Move(quarantine, path); } catch { }
                return false;
            }
            File.Delete(quarantine);
            return true;
        }
        catch (FileNotFoundException) { return true; }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    private static (long Length, long CreationTicks, long WriteTicks, string Content)? Snapshot(string path)
    {
        var info = new FileInfo(path); info.Refresh();
        if (!info.Exists) return null;
        var length = info.Length; var creationTicks = info.CreationTimeUtc.Ticks; var writeTicks = info.LastWriteTimeUtc.Ticks;
        var content = ReadOwnerText(path);
        info.Refresh();
        if (!info.Exists) return null;
        if (info.Length != length || info.CreationTimeUtc.Ticks != creationTicks || info.LastWriteTimeUtc.Ticks != writeTicks) throw new IOException("Update lock changed while its snapshot was read");
        return (length, creationTicks, writeTicks, content);
    }

    private static UpdateLockOwnerV1? ParseOwner(string text)
    {
        try
        {
            using var document = JsonDocument.Parse(text); var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            var names = root.EnumerateObject().Select(x => x.Name).ToArray();
            if (names.Length != 5 || !new[] { "schema", "token", "pid", "hostname", "createdAt" }.All(names.Contains)) return null;
            var token = root.GetProperty("token").GetString(); var hostname = root.GetProperty("hostname").GetString(); var createdAt = root.GetProperty("createdAt").GetString();
            if (!root.GetProperty("schema").TryGetInt32(out var schema) || schema != 1 || string.IsNullOrEmpty(token) || token.Length > 256 || string.IsNullOrEmpty(hostname) ||
                !root.GetProperty("pid").TryGetInt32(out var pid) || pid <= 0 || createdAt is null || !TryParseCreatedAt(createdAt, out _)) return null;
            return new(1, token, pid, hostname, createdAt);
        }
        catch { return null; }
    }

    private static DateTimeOffset ParseCreatedAt(string value) => TryParseCreatedAt(value, out var timestamp) ? timestamp : throw new FormatException("Invalid update lock timestamp");

    private static bool TryParseCreatedAt(string value, out DateTimeOffset timestamp) =>
        DateTimeOffset.TryParseExact(value, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out timestamp);

    private static bool IsProcessAlive(int pid)
    {
        try { using var process = Process.GetProcessById(pid); return !process.HasExited; }
        catch (ArgumentException) { return false; }
        catch { return true; }
    }
}

internal sealed record InstalledSelection(ActivePointerV1 Pointer, ValidatedInstallation Installation);

internal sealed class InstalledSelectionResolver
{
    private readonly LauncherLayout layout;

    internal InstalledSelectionResolver(LauncherLayout layout) => this.layout = layout;

    internal InstalledSelection? ResolveActive()
    {
        ActivePointerV1? pointer = LocalActivationStore.RecoverAndReadCurrent(layout);
        return pointer is not null && TryValidate(pointer.ActiveBuildId, pointer.ActiveRuntimeId, out ValidatedInstallation? installation)
            ? new InstalledSelection(pointer, installation!)
            : null;
    }

    internal bool TryValidate(string buildId, string runtimeId, out ValidatedInstallation? installation)
    {
        installation = null;
        try
        {
            if (!Protocol.IsBuildId(buildId) || !Protocol.IsRuntimeId(runtimeId)) return false;
            string root = LauncherEngine.RequireRealDirectory(layout.Root, Path.GetDirectoryName(layout.Root)!);
            string appsRoot = LauncherEngine.RequireRealDirectory(layout.Apps, root);
            string runtimesRoot = LauncherEngine.RequireRealDirectory(layout.Runtimes, root);
            string appDirectory = LauncherEngine.RequireRealDirectory(Path.Combine(appsRoot, buildId), appsRoot);
            string runtimeDirectory = LauncherEngine.RequireRealDirectory(Path.Combine(runtimesRoot, runtimeId), runtimesRoot);
            InstalledAppManifestV1 app = Protocol.ParseAppManifest(File.ReadAllText(LauncherEngine.RequireContainedFile(appDirectory, "manifest.json")));
            InstalledRuntimeManifestV1 runtime = Protocol.ParseRuntimeManifest(File.ReadAllText(LauncherEngine.RequireContainedFile(runtimeDirectory, "manifest.json")));
            if (app.BuildId != buildId || runtime.RuntimeId != runtimeId || app.RuntimeId != runtimeId) return false;
            LauncherEngine.VerifyFiles(appDirectory, app.Files, app.Entrypoint);
            LauncherEngine.VerifyFiles(runtimeDirectory, runtime.Files, runtime.Entrypoints.Python, runtime.Entrypoints.Comfyui);
            string entrypoint = LauncherEngine.RequireContainedFile(appDirectory, app.Entrypoint);
            installation = new(app, runtime, appDirectory, runtimeDirectory, entrypoint, LauncherEngine.CaptureFileIdentity(entrypoint));
            return true;
        }
        catch
        {
            return false;
        }
    }
}

internal sealed class IntegrityViolationException : Exception
{
    internal const int ExitCode = 73;
    internal IntegrityViolationException(string message, Exception innerException) : base(message, innerException) { }
}

public sealed class LauncherEngine
{
    public const int RollbackThreshold = 3;
    public static readonly TimeSpan HealthTimeout = TimeSpan.FromSeconds(60);
    private readonly LauncherLayout layout;
    private readonly Func<DateTimeOffset> now;
    private readonly TimeSpan healthTimeout;
    private readonly LauncherUpdateConfiguration updateConfiguration;
    private readonly IChannelManifestClientFactory manifestClientFactory;
    private readonly IAutoUpdateCoordinatorFactory autoUpdateCoordinatorFactory;
    private readonly IInstalledProcessStarter processStarter;
    private readonly TimeSpan runtimeIntegrityInterval;
    private LauncherCommandRequestV1? activeCommand;
    private bool activeCommandCompleted;

    internal LauncherEngine(LauncherLayout layout, Func<DateTimeOffset>? now = null, TimeSpan? healthTimeout = null, LauncherUpdateConfiguration? updateConfiguration = null, IChannelManifestClientFactory? manifestClientFactory = null, IAutoUpdateCoordinatorFactory? autoUpdateCoordinatorFactory = null, IInstalledProcessStarter? processStarter = null, TimeSpan? runtimeIntegrityInterval = null)
    {
        this.layout = layout;
        this.now = now ?? (() => DateTimeOffset.UtcNow);
        this.healthTimeout = healthTimeout ?? HealthTimeout;
        this.updateConfiguration = updateConfiguration ?? CompiledLauncherUpdateConfiguration.Create();
        this.manifestClientFactory = manifestClientFactory ?? new DefaultChannelManifestClientFactory();
        this.autoUpdateCoordinatorFactory = autoUpdateCoordinatorFactory ?? new DefaultAutoUpdateCoordinatorFactory();
        this.processStarter = processStarter ?? new DirectInstalledProcessStarter();
        this.runtimeIntegrityInterval = runtimeIntegrityInterval ?? TimeSpan.FromMilliseconds(500);
        if (this.healthTimeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(healthTimeout));
        if (this.runtimeIntegrityInterval <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(runtimeIntegrityInterval));
    }

    public async Task<int> RunAsync(IReadOnlyList<string> arguments)
    {
        LocalActivationStore.Recover(layout);
        Directory.CreateDirectory(layout.Root);
        Log("info", "launcher_start", new { argumentCount = arguments.Count });
        using var mutex = CreateMutex(layout.Root, out var ownsMutex);
        if (!ownsMutex) throw new InvalidOperationException("Another launcher process holds the per-root launcher mutex");
        RecoverExpiredPending();
        LauncherCommandRequestV1? command = LauncherCommandStore.Consume(layout, now());
        activeCommand = command;
        activeCommandCompleted = false;
        try
        {
        var health = LoadHealthStrict();
        if (health.Pending is not null) throw new InvalidOperationException("A non-expired launcher health check is already pending");
        if (health.FailedAttemptCount >= RollbackThreshold)
        {
            Log("error", "failure_threshold_reached", new { health.FailedAttemptCount });
            RollbackAtThreshold(null);
            health = LoadHealthStrict();
            if (health.FailedAttemptCount >= RollbackThreshold) throw new InvalidOperationException("Launch refused because the consecutive failure threshold was reached");
        }

        var selected = RepairPointer(Select());
        if (command?.Command == "remove-version")
        {
            RemoveInstalledVersion(command.BuildId ?? throw new ProtocolException("Removal build ID is missing"));
            CompleteCommand("completed");
            command = null;
            activeCommand = null;
        }
        var beforeSelection = selected;
        var beforePointer = selected.Pointer ?? throw new InvalidOperationException("The selected installation is not bound to an active pointer");
        if (command?.Command == "rollback")
        {
            if (beforePointer.PreviousBuildId is null || beforePointer.PreviousRuntimeId is null ||
                !TryValidate(beforePointer.PreviousBuildId, beforePointer.PreviousRuntimeId, out ValidatedInstallation? previous))
            {
                CompleteCommand("failed", "No valid retained previous version is available");
            }
            else
            {
                var rolledBack = new ActivePointerV1(1, beforePointer.PreviousBuildId, beforePointer.PreviousRuntimeId, beforePointer.ActiveBuildId, beforePointer.ActiveRuntimeId, LauncherTime.Timestamp(now()));
                CommitActivation(beforePointer, rolledBack);
                selected = new(previous!, "active", rolledBack);
                beforeSelection = selected;
                beforePointer = rolledBack;
                CompleteCommand("completed");
            }
        }
        UpdateCheckOutcome update;
        try
        {
            var settings = LauncherSettingsStore.Read(layout.Root);
            if (command?.Command is "check-now" or "install-latest")
                settings = settings with { UpdateMode = command.Command == "install-latest" ? "auto-on-launch" : "notify-on-launch" };
            update = await LauncherUpdateCheck.RunAsync(layout, selected.Installation, settings, updateConfiguration, manifestClientFactory).ConfigureAwait(false);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or OfflineUpdateException or DecoderFallbackException or ChannelManifestClientException or ArgumentException)
        {
            var settings = LauncherSettingsStore.Default;
            update = new(settings, new(settings.UpdateMode, "failed", settings.Channel));
            Log("error", "update_check_failed", new { error = error.ToString() });
        }
        var updateResult = update.Status;
        Log(updateResult.Status == "failed" ? "error" : "info", "update_check_result", new { updateResult.Mode, updateResult.Status, updateResult.Channel, updateResult.Version });

        if (update.Settings.UpdateMode == "auto-on-launch" && updateResult.Status == "available" && update.Load is not null && update.Candidate is not null)
        {
            AutoUpdateResult autoResult;
            try
            {
                var current = update.Candidate with
                {
                    App = update.Candidate.App with { Version = selected.Installation.App.Version, BuildId = selected.Installation.App.BuildId, RuntimeId = selected.Installation.Runtime.RuntimeId },
                    Runtime = update.Candidate.Runtime with { RuntimeId = selected.Installation.Runtime.RuntimeId }
                };
                autoResult = await autoUpdateCoordinatorFactory.Create().ExecuteAsync(layout, update.Settings, updateConfiguration, update.Load, update.Candidate, current).ConfigureAwait(false);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                Log("error", "auto_update_failed", new { error = error.ToString() });
                autoResult = AutoUpdateResult.Failed(updateResult.Version, "coordinator-failed", "coordinator", "The automatic update failed.");
            }
            updateResult = new(update.Settings.UpdateMode, autoResult.Status, update.Settings.Channel, autoResult.Status == "installed" ? autoResult.Version : null);
            if (autoResult.Status == "installed")
            {
                selected = ResolveAfterInstalled(update.Candidate, beforeSelection, beforePointer, ref updateResult);
            }
            Log(updateResult.Status == "failed" ? "error" : "info", "auto_update_result", new { updateResult.Status, updateResult.Version });
        }

        if (command?.Command is "check-now" or "install-latest")
            CompleteCommand(updateResult.Status == "failed" ? "failed" : "completed", updateResult.Status == "failed" ? "Launcher update operation failed" : null);

        selected = ResolveLaunchSelection(selected);
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var started = now();
        PendingLauncherHealthV1 launchPending = MutateHealth(() =>
        {
            health = LoadHealthStrict();
            if (health.Pending is not null) throw new InvalidOperationException("A non-expired launcher health check is already pending");
            var freshPending = new PendingLauncherHealthV1(selected.Installation.App.BuildId, selected.Installation.Runtime.RuntimeId, token, health.FailedAttemptCount + 1, LauncherTime.Timestamp(started), LauncherTime.Timestamp(started + healthTimeout));
            AtomicJson.Write(layout.Health, new LauncherHealthStateV1(1, health.FailedAttemptCount, freshPending));
            return freshPending;
        });
        Log("info", "launch_pending", new { launchPending.BuildId, launchPending.RuntimeId, token = TokenSummary(token), launchPending.AttemptCount, launchPending.Deadline });

        ActivePointerV1 launchPointer = selected.Pointer ?? throw new InvalidOperationException("The final launch selection has no active pointer");
        ControlledProcess? controlledProcess = null;
        Process? process = null;
        InstalledLaunchLease? launchLease = null;
        CancellationTokenSource? monitorCancellation = null;
        Task<Exception?>? integrityMonitor = null;
        Task<bool>? healthTask = null;
        var healthAccepted = false;
        var failureRecorded = false;
        try
        {
            launchLease = InstalledLaunchLease.Acquire(layout, new InstalledSelection(launchPointer, selected.Installation));
            if (!SamePointer(launchPointer, LocalActivationStore.ReadCurrent(layout))) throw new InvalidOperationException("The active pointer changed before launch lease acquisition completed");
            WindowsDllSearchHardening.EnsureInitialized();
            ProcessStartInfo startInfo = BuildProcessStartInfo(selected.Installation, arguments, token, layout.Root, updateResult);
            controlledProcess = processStarter.Start(launchLease, startInfo);
            process = controlledProcess.Process;
            monitorCancellation = new CancellationTokenSource();
            integrityMonitor = MonitorRuntimeIntegrityAsync(launchLease, process, monitorCancellation.Token);
            healthTask = WaitForHealthAsync(process, launchPending, monitorCancellation.Token);
            Task first = await Task.WhenAny(healthTask, integrityMonitor).ConfigureAwait(false);
            if (first == integrityMonitor && await integrityMonitor.ConfigureAwait(false) is Exception beforeHealthViolation)
            {
                monitorCancellation.Cancel();
                RecordFailureAndRollbackIfNeeded(launchPending, "integrity_violation_before_health");
                failureRecorded = true;
                throw new IntegrityViolationException("Installed tree integrity changed before health confirmation", beforeHealthViolation);
            }
            if (!await healthTask.ConfigureAwait(false))
            {
                monitorCancellation.Cancel();
                RecordFailureAndRollbackIfNeeded(launchPending, process.HasExited ? "early_exit" : "timeout_or_invalid_health");
                failureRecorded = true;
                throw new InvalidOperationException("Application did not confirm healthy before exit/deadline");
            }
            healthAccepted = true;
            Log("info", "launch_healthy", new { launchPending.BuildId, launchPending.RuntimeId, token = TokenSummary(token) });

            Task exitTask = process.WaitForExitAsync();
            first = await Task.WhenAny(exitTask, integrityMonitor).ConfigureAwait(false);
            if (first == integrityMonitor && await integrityMonitor.ConfigureAwait(false) is Exception violation)
            {
                monitorCancellation.Cancel();
                Log("error", "integrity_violation", new { error = violation.ToString(), launchPending.BuildId, launchPending.RuntimeId });
                return IntegrityViolationException.ExitCode;
            }
            await exitTask.ConfigureAwait(false);
            return 0;
        }
        catch (Exception error)
        {
            monitorCancellation?.Cancel();
            if (!healthAccepted && !failureRecorded) RecordFailureAndRollbackIfNeeded(launchPending, process is null ? "start_error" : "launch_error");
            Log("error", "launch_failed", new { error = error.ToString(), launchPending.BuildId, launchPending.RuntimeId, token = TokenSummary(token) });
            throw;
        }
        finally
        {
            monitorCancellation?.Cancel();
            if (integrityMonitor is not null) await ObserveMonitorAsync(integrityMonitor).ConfigureAwait(false);
            if (healthTask is not null) await ObserveHealthTaskAsync(healthTask).ConfigureAwait(false);
            LauncherProcessTerminationException? fatalTermination = null;
            if (controlledProcess is not null)
            {
                try { ProcessTreeTermination.TerminateAndWait(controlledProcess); }
                catch (LauncherProcessTerminationException error)
                {
                    fatalTermination = error;
                    if (launchLease is not null)
                    {
                        ControlledProcess transferredProcess = controlledProcess;
                        InstalledLaunchLease transferredLease = launchLease;
                        controlledProcess = null;
                        launchLease = null;
                        ProcessContainmentRegistry.RegisterNoThrow(transferredProcess, transferredLease);
                    }
                }
            }
            launchLease?.Dispose();
            monitorCancellation?.Dispose();
            controlledProcess?.Dispose();
            if (fatalTermination is not null) throw fatalTermination;
        }
        }
        catch (Exception error)
        {
            CompleteCommand("failed", error is OperationCanceledException ? "Launcher command was cancelled" : error.Message);
            throw;
        }
        finally
        {
            CompleteCommand("failed", "Launcher command did not reach a terminal outcome");
            activeCommand = null;
        }
    }

    private void RemoveInstalledVersion(string buildId)
    {
        // Safe removal requires an exclusive installed-tree lease that conflicts with every
        // launched process and pins all executable/manifest handles. The current launch lease
        // is intentionally shared/read-only and cannot prove exclusivity, so fail closed.
        // Runtime cleanup is likewise deferred until all valid and corrupt app directories can
        // be proven not to reference the runtime.
        throw new NotSupportedException($"Installed-version removal is unsupported for build {buildId}: an exclusive process lease is not available");
    }

    private void CompleteCommand(string status, string? error = null)
    {
        if (activeCommand is null || activeCommandCompleted) return;
        try
        {
            LauncherCommandStore.WriteResult(layout, new(1, activeCommand.RequestId, activeCommand.Command, status, LauncherTime.Timestamp(now()), error));
            activeCommandCompleted = true;
        }
        catch (Exception writeError)
        {
            Log("error", "launcher_command_result_write_failed", new { activeCommand.RequestId, activeCommand.Command, status, error = writeError.ToString() });
        }
    }

    private static async Task ObserveMonitorAsync(Task<Exception?> monitor)
    {
        Task completed = await Task.WhenAny(monitor, Task.Delay(TimeSpan.FromSeconds(2))).ConfigureAwait(false);
        if (completed == monitor) _ = await monitor.ConfigureAwait(false);
    }

    private static async Task ObserveHealthTaskAsync(Task<bool> healthTask)
    {
        Task completed = await Task.WhenAny(healthTask, Task.Delay(TimeSpan.FromSeconds(2))).ConfigureAwait(false);
        if (completed != healthTask) return;
        try { _ = await healthTask.ConfigureAwait(false); }
        catch (OperationCanceledException) { }
    }

    private async Task<Exception?> MonitorRuntimeIntegrityAsync(InstalledLaunchLease lease, Process process, CancellationToken cancellationToken)
    {
        try
        {
            while (!process.HasExited)
            {
                lease.ValidateRuntimeIntegrity();
                await Task.Delay(runtimeIntegrityInterval, cancellationToken).ConfigureAwait(false);
            }
            return null;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { return null; }
        catch (Exception error) { return error; }
    }

    private LaunchSelection ResolveAfterInstalled(SelectedArtifactsV1 candidate, LaunchSelection beforeSelection, ActivePointerV1 beforePointer, ref UpdateLaunchResult updateResult)
    {
        if (beforeSelection.Pointer is null || !SamePointer(beforeSelection.Pointer, beforePointer)) throw new InvalidOperationException("The pre-update selection changed before automatic update verification");
        try
        {
            ActivePointerV1? actual = LocalActivationStore.RecoverAndReadCurrent(layout);
            var candidateIsCurrent = actual is not null && actual.ActiveBuildId == candidate.App.BuildId && actual.ActiveRuntimeId == candidate.Runtime.RuntimeId;
            InstalledSelection? resolved = null;
            if (candidateIsCurrent && new InstalledSelectionResolver(layout).TryValidate(candidate.App.BuildId, candidate.Runtime.RuntimeId, out ValidatedInstallation? candidateInstallation))
            {
                resolved = new InstalledSelection(actual!, candidateInstallation!);
            }
            if (candidateIsCurrent && resolved is not null && SamePointer(resolved.Pointer, actual) &&
                resolved.Installation.App.BuildId == candidate.App.BuildId && resolved.Installation.Runtime.RuntimeId == candidate.Runtime.RuntimeId)
            {
                return new(resolved.Installation, "active", resolved.Pointer);
            }

            updateResult = new(updateResult.Mode, "failed", updateResult.Channel);
            Log("error", "auto_update_active_verification_failed", new { reason = "active-verification-failed", candidate.App.BuildId, candidate.Runtime.RuntimeId });
            if (candidateIsCurrent)
            {
                LocalActivationStore.Commit(layout, actual, beforePointer, now());
                InstalledSelection restored = ResolveStableActive();
                if (!SamePointer(restored.Pointer, beforePointer)) throw new InvalidOperationException("Automatic update rollback did not restore the prior active pointer");
                return new(restored.Installation, "active", restored.Pointer);
            }

            InstalledSelection winner = ResolveStableActive();
            return new(winner.Installation, "active", winner.Pointer);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            Log("error", "auto_update_final_resolve_failed", new { reason = "active-verification-failed", candidate.App.BuildId, candidate.Runtime.RuntimeId, error = error.ToString() });
            throw new InvalidOperationException("Automatic update active verification failed; launch was refused", error);
        }
    }

    private LaunchSelection ResolveLaunchSelection(LaunchSelection expected)
    {
        InstalledSelection resolved = ResolveStableActive();
        if (expected.Pointer is not null && !SamePointer(resolved.Pointer, expected.Pointer))
        {
            Log("info", "active_selection_changed_before_launch", new { resolved.Pointer.ActiveBuildId, resolved.Pointer.ActiveRuntimeId });
        }
        return new(resolved.Installation, "active", resolved.Pointer);
    }

    private InstalledSelection ResolveStableActive()
    {
        var resolver = new InstalledSelectionResolver(layout);
        for (var attempt = 0; attempt < 3; attempt++)
        {
            InstalledSelection? resolved = resolver.ResolveActive();
            if (resolved is null) throw new InvalidOperationException("The active installation could not be securely resolved");
            ActivePointerV1? current = LocalActivationStore.ReadCurrent(layout);
            if (SamePointer(resolved.Pointer, current)) return resolved;
        }
        throw new InvalidOperationException("The active pointer changed repeatedly during secure resolution");
    }

    public LaunchSelection Select()
    {
        ActivePointerV1? pointer = null;
        if (File.Exists(layout.ActivePointer))
        {
            try { pointer = Protocol.ParseActivePointer(File.ReadAllText(layout.ActivePointer)); }
            catch (Exception error) { Log("error", "active_pointer_invalid", new { error = error.Message }); }
        }
        if (pointer is not null)
        {
            if (TryValidate(pointer.ActiveBuildId, pointer.ActiveRuntimeId, out var active)) return new(active!, "active", pointer);
            Log("error", "active_installation_invalid", new { pointer.ActiveBuildId, pointer.ActiveRuntimeId });
            if (pointer.PreviousBuildId is not null && pointer.PreviousRuntimeId is not null && TryValidate(pointer.PreviousBuildId, pointer.PreviousRuntimeId, out var previous)) return new(previous!, "previous", pointer);
        }
        var newest = Directory.Exists(layout.Apps) ? Directory.EnumerateDirectories(layout.Apps).Take(1000).Select(directory =>
        {
            try { var app = Protocol.ParseAppManifest(File.ReadAllText(RequireContainedFile(directory, "manifest.json"))); return TryValidate(Path.GetFileName(directory), app.RuntimeId, out var install) ? install : null; }
            catch { return null; }
        }).Where(x => x is not null).OrderByDescending(x => DateTimeOffset.Parse(x!.App.CreatedAt, CultureInfo.InvariantCulture)).ThenByDescending(x => x!.App.BuildId, StringComparer.Ordinal).FirstOrDefault() : null;
        if (newest is null) { Log("error", "no_valid_version", new { }); throw new InvalidOperationException("No valid installed app/runtime combination is available"); }
        return new(newest, "installed", pointer);
    }

    public bool TryValidate(string buildId, string runtimeId, out ValidatedInstallation? installation) =>
        new InstalledSelectionResolver(layout).TryValidate(buildId, runtimeId, out installation);

    private void CommitActivation(ActivePointerV1? from, ActivePointerV1 to) => LocalActivationStore.Commit(layout, from, to, now());

    private LaunchSelection RepairPointer(LaunchSelection selected)
    {
        if (selected.Source == "active") return selected;
        var prior = selected.Pointer;
        // A fallback repair may retain only a combination independently proven valid.
        var preservePriorActive = prior is not null && TryValidate(prior.ActiveBuildId, prior.ActiveRuntimeId, out _);
        var pointer = new ActivePointerV1(1, selected.Installation.App.BuildId, selected.Installation.Runtime.RuntimeId, preservePriorActive ? prior!.ActiveBuildId : null, preservePriorActive ? prior!.ActiveRuntimeId : null, LauncherTime.Timestamp(now()));
        if (prior is not null) CommitActivation(prior, pointer);
        else
        {
            try { LocalActivationStore.RepairInvalidCurrent(layout, pointer); }
            catch (StaleActivationException)
            {
                InstalledSelection? concurrent = new InstalledSelectionResolver(layout).ResolveActive();
                if (concurrent is null) throw;
                return new(concurrent.Installation, "active", concurrent.Pointer);
            }
        }
        return new(selected.Installation, "active", pointer);
    }

    public static ProcessStartInfo BuildProcessStartInfo(ValidatedInstallation selected, IReadOnlyList<string> arguments, string token, string launcherRoot, UpdateLaunchResult? updateResult = null)
    {
        var info = new ProcessStartInfo(selected.AppEntrypoint) { UseShellExecute = false, WorkingDirectory = selected.AppDirectory, WindowStyle = ProcessWindowStyle.Hidden };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        foreach (var key in info.Environment.Keys.Where(key => key.StartsWith("MAGICPOT_UPDATE_", StringComparison.OrdinalIgnoreCase)).ToArray()) info.Environment.Remove(key);
        info.Environment["MAGICPOT_LAUNCH_TOKEN"] = token;
        info.Environment["MAGICPOT_LAUNCH_BUILD_ID"] = selected.App.BuildId;
        info.Environment["MAGICPOT_LAUNCH_RUNTIME_ID"] = selected.Runtime.RuntimeId;
        info.Environment["MAGICPOT_RUNTIME_DIR"] = selected.RuntimeDirectory;
        info.Environment["MAGICPOT_ACTIVE_BUILD_ID"] = selected.App.BuildId;
        info.Environment["MAGICPOT_ACTIVE_BUILD"] = selected.App.BuildId;
        info.Environment["MAGICPOT_ACTIVE_RUNTIME_ID"] = selected.Runtime.RuntimeId;
        info.Environment["MAGICPOT_ACTIVE_RUNTIME"] = selected.Runtime.RuntimeId;
        info.Environment["MAGICPOT_LAUNCHER_ROOT"] = launcherRoot;
        if (updateResult is not null)
        {
            info.Environment["MAGICPOT_UPDATE_MODE"] = updateResult.Mode;
            info.Environment["MAGICPOT_UPDATE_STATUS"] = updateResult.Status;
            info.Environment["MAGICPOT_UPDATE_CHANNEL"] = updateResult.Channel;
            if ((updateResult.Status == "available" || updateResult.Status == "installed") && LauncherUpdateCheck.IsEnvironmentVersion(updateResult.Version)) info.Environment["MAGICPOT_UPDATE_VERSION"] = updateResult.Version;
        }
        return info;
    }

    private async Task<bool> WaitForHealthAsync(Process process, PendingLauncherHealthV1 pending, CancellationToken cancellationToken)
    {
        while (now() < DateTimeOffset.Parse(pending.Deadline, CultureInfo.InvariantCulture))
        {
            if (process.HasExited) return false;
            LauncherHealthStateV1 state;
            try
            {
                state = MutateHealth(() =>
                {
                    if (!File.Exists(layout.Health)) throw new IOException("Launcher health disappeared while confirmation was pending");
                    return Protocol.ParseHealth(File.ReadAllText(layout.Health));
                });
            }
            catch (Exception error) { Log("error", "health_read_failed", new { error = error.ToString() }); throw new InvalidOperationException("Launcher health could not be read safely", error); }
            if (state.Pending is null) return IsAcceptedHealthTransition(state, pending);
            if (!SamePending(state.Pending, pending)) return false;
            await Task.Delay(250, cancellationToken).ConfigureAwait(false);
        }
        return false;
    }

    public static bool IsAcceptedHealthTransition(LauncherHealthStateV1 state, PendingLauncherHealthV1 pending)
    {
        if (state.Pending is not null || state.FailedAttemptCount != 0 || state.LastHealthy is null) return false;
        var receipt = state.LastHealthy;
        return receipt.BuildId == pending.BuildId && receipt.RuntimeId == pending.RuntimeId && receipt.LaunchToken == pending.LaunchToken &&
            DateTimeOffset.TryParseExact(receipt.ConfirmedAt, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var confirmedAt) &&
            DateTimeOffset.TryParseExact(pending.StartedAt, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var startedAt) &&
            DateTimeOffset.TryParseExact(pending.Deadline, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var deadline) &&
            confirmedAt >= startedAt && confirmedAt < deadline;
    }

    private void RecoverExpiredPending()
    {
        var state = MutateHealth(LoadHealthStrict);
        if (state.Pending is not null && now() >= DateTimeOffset.Parse(state.Pending.Deadline, CultureInfo.InvariantCulture)) RecordFailureAndRollbackIfNeeded(state.Pending, "expired_pending");
    }

    private void RecordFailureAndRollbackIfNeeded(PendingLauncherHealthV1 pending, string reason)
    {
        var accepted = false;
        MutateHealth(() =>
        {
            var state = LoadHealthStrict();
            if (state.Pending is null || !SamePending(state.Pending, pending)) return;
            AtomicJson.Write(layout.Health, new LauncherHealthStateV1(1, state.Pending.AttemptCount)); accepted = true;
        });
        if (!accepted) { Log("error", "failure_identity_mismatch", new { reason, token = TokenSummary(pending.LaunchToken) }); return; }
        Log("error", "launch_attempt_failed", new { reason, pending.AttemptCount, pending.BuildId, pending.RuntimeId, token = TokenSummary(pending.LaunchToken) });
        if (pending.AttemptCount >= RollbackThreshold) RollbackAtThreshold(pending);
    }

    private void RollbackAtThreshold(PendingLauncherHealthV1? failed)
    {
        ActivePointerV1 pointer;
        try { pointer = Protocol.ParseActivePointer(File.ReadAllText(layout.ActivePointer)); }
        catch (Exception error) { Log("error", "rollback_pointer_invalid", new { error = error.Message }); return; }
        if (failed is not null && (pointer.ActiveBuildId != failed.BuildId || pointer.ActiveRuntimeId != failed.RuntimeId)) return;
        if (pointer.PreviousBuildId is null || pointer.PreviousRuntimeId is null || !TryValidate(pointer.PreviousBuildId, pointer.PreviousRuntimeId, out _)) { Log("error", "rollback_target_invalid", new { }); return; }
        var rolledBack = new ActivePointerV1(1, pointer.PreviousBuildId, pointer.PreviousRuntimeId, pointer.ActiveBuildId, pointer.ActiveRuntimeId, LauncherTime.Timestamp(now()));
        CommitActivation(pointer, rolledBack);
        Log("info", "rollback_committed", new { rolledBack.ActiveBuildId, rolledBack.ActiveRuntimeId });
    }

    private LauncherHealthStateV1 LoadHealthStrict() => File.Exists(layout.Health) ? Protocol.ParseHealth(File.ReadAllText(layout.Health)) : new(1, 0);
    private T MutateHealth<T>(Func<T> operation) { using var fileLock = UpdateFileLock.Acquire(layout.HealthLock, stale: UpdateFileLock.HealthLockStale); return operation(); }
    private void MutateHealth(Action operation) { using var fileLock = UpdateFileLock.Acquire(layout.HealthLock, stale: UpdateFileLock.HealthLockStale); operation(); }

    internal static void VerifyFiles(string directory, IReadOnlyList<InstalledFileV1>? files, params string[] entrypoints)
    {
        if (files is null || files.Count == 0) throw new IOException("Installed manifest files must be non-empty");
        var map = files.ToDictionary(x => x.Path.Replace('\\', '/'), StringComparer.OrdinalIgnoreCase);
        foreach (var entry in entrypoints) if (!map.ContainsKey(entry.Replace('\\', '/'))) throw new IOException("Entrypoint is not present in manifest files");
        foreach (var file in files)
        {
            if (string.Equals(file.Path.Replace('\\', '/'), "manifest.json", StringComparison.OrdinalIgnoreCase)) throw new IOException("manifest.json must not be listed in files");
            var path = RequireContainedFile(directory, file.Path); var info = new FileInfo(path);
            if (info.Length != file.Size) throw new IOException($"File length mismatch: {file.Path}");
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read); var hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
            if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(hash), Encoding.ASCII.GetBytes(file.Sha256))) throw new IOException($"File hash mismatch: {file.Path}");
        }
    }

    public static LaunchFileIdentity CaptureFileIdentity(string path)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows file identity is required");
        using var handle = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, FileOptions.None);
        if (!GetFileInformationByHandle(handle, out var information)) throw new IOException("GetFileInformationByHandle failed", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
        if ((information.FileAttributes & (uint)FileAttributes.Directory) != 0) throw new IOException("Launch path is not a file");
        var length = ((long)information.FileSizeHigh << 32) | information.FileSizeLow;
        var fileIndex = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
        return new(information.VolumeSerialNumber, fileIndex, length);
    }
    public static bool SameFileIdentity(LaunchFileIdentity left, LaunchFileIdentity right) => left == right;

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out ByHandleFileInformation information);
    private static bool SamePointer(ActivePointerV1? left, ActivePointerV1? right) => left is null || right is null ? left is null && right is null : left.Schema == right.Schema && left.ActiveBuildId == right.ActiveBuildId && left.ActiveRuntimeId == right.ActiveRuntimeId && left.PreviousBuildId == right.PreviousBuildId && left.PreviousRuntimeId == right.PreviousRuntimeId && left.ActivatedAt == right.ActivatedAt;
    private static bool SamePending(PendingLauncherHealthV1 left, PendingLauncherHealthV1 right) => left.BuildId == right.BuildId && left.RuntimeId == right.RuntimeId && left.LaunchToken == right.LaunchToken;
    private static Mutex CreateMutex(string root, out bool owns) { var name = "Local\\MagicPot.Launcher." + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Path.GetFullPath(root).ToUpperInvariant()))); return new Mutex(true, name, out owns); }

    internal static string RequireRealDirectory(string path, string parent)
    {
        var full = Path.GetFullPath(path); var parentFull = Path.GetFullPath(parent);
        if (!IsInside(parentFull, full)) throw new IOException("Directory escapes parent");
        var info = new DirectoryInfo(full);
        if (!info.Exists || info.LinkTarget is not null || (info.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Redirected or missing directory");
        return full;
    }

    internal static string RequireContainedFile(string directory, string relative)
    {
        if (!Protocol.IsSafeRelativePath(relative)) throw new IOException("Unsafe path");
        var root = Path.GetFullPath(directory); var current = root;
        foreach (var segment in relative.Split(['/', '\\']))
        {
            current = Path.Combine(current, segment);
            var attributes = File.GetAttributes(current);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Reparse point in managed path");
        }
        var candidate = Path.GetFullPath(current);
        if (!IsInside(root, candidate)) throw new IOException("Path escapes directory");
        var info = new FileInfo(candidate);
        if (!info.Exists || (info.Attributes & FileAttributes.Directory) != 0 || info.LinkTarget is not null || (info.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Installed path is not a regular file");
        return info.FullName;
    }

    private static bool IsInside(string parent, string child) { var relative = Path.GetRelativePath(Path.GetFullPath(parent), Path.GetFullPath(child)); return relative == "." || (!Path.IsPathFullyQualified(relative) && relative != ".." && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)); }
    private static string TokenSummary(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant()[..12];

    private void Log(string level, string eventName, object data)
    {
        try
        {
            Directory.CreateDirectory(layout.Root);
            var line = JsonSerializer.Serialize(new { timestamp = LauncherTime.Timestamp(now()), level, @event = eventName, data }, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
            using var stream = new FileStream(layout.Log, FileMode.Append, FileAccess.Write, FileShare.ReadWrite); using var writer = new StreamWriter(stream, new UTF8Encoding(false)); writer.WriteLine(line);
        }
        catch { }
    }
}
