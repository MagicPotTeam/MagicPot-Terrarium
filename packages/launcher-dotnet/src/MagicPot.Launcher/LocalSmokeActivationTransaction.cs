using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
using System.Text;
using System.Text.Json;

namespace MagicPot.Launcher;

internal class LocalSmokeActivationException : Exception
{
    internal LocalSmokeActivationException(string message) : base(message) { }
    internal LocalSmokeActivationException(string message, Exception innerException) : base(message, innerException) { }
}

internal sealed class StaleActivationException : LocalSmokeActivationException
{
    internal StaleActivationException() : base("stale activation source") { }
}

internal sealed class LocalSmokeActivationOptions
{
    internal TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(60);
    internal TimeSpan HardTerminationTimeout { get; init; } = TimeSpan.FromSeconds(5);
    internal string? TemporaryRoot { get; init; }
    internal Func<DateTimeOffset>? Clock { get; init; }
    internal IProcessLauncher? ProcessLauncher { get; init; }
}

internal sealed record SmokeProcessRequest(ProcessStartInfo StartInfo, TimeSpan Timeout, TimeSpan HardTerminationTimeout);
internal sealed record SmokeProcessResult(int ExitCode, bool TimedOut, string StandardOutput, string StandardError, bool StdoutExceeded, bool StderrExceeded);
internal interface IProcessLauncher { SmokeProcessResult Launch(InstalledArtifactReceipt appReceipt, InstalledArtifactReceipt runtimeReceipt, SmokeProcessRequest request); }
internal sealed record SmokeActivationInfo(string Version, string BuildId, int ExitCode, string StandardOutput, string StandardError);
internal sealed record ActivationReceipt(ActivePointerV1? Previous, ActivePointerV1 Current, SmokeActivationInfo? Smoke, bool NoOp);

internal sealed class LocalSmokeActivationTransaction
{
    private readonly LauncherLayout layout;
    private readonly LocalSmokeActivationOptions options;
    private readonly Func<DateTimeOffset> clock;

    internal LocalSmokeActivationTransaction(LauncherLayout layout, LocalSmokeActivationOptions? options = null)
    {
        this.layout = layout ?? throw new ArgumentNullException(nameof(layout));
        this.options = options ?? new LocalSmokeActivationOptions();
        clock = this.options.Clock ?? (static () => DateTimeOffset.UtcNow);
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Local smoke activation is Windows-only.");
        if (this.options.Timeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(options));
        if (this.options.HardTerminationTimeout < TimeSpan.FromSeconds(0.1) || this.options.HardTerminationTimeout > TimeSpan.FromSeconds(30)) throw new ArgumentOutOfRangeException(nameof(options));
        WindowsDllSearchHardening.EnsureInitialized();
    }

    internal ActivationReceipt Execute(InstalledArtifactReceipt appReceipt, InstalledArtifactReceipt runtimeReceipt) =>
        Execute(appReceipt, runtimeReceipt, LocalActivationStore.RecoverAndReadCurrent(layout));

    internal ActivationReceipt Execute(InstalledArtifactReceipt appReceipt, InstalledArtifactReceipt runtimeReceipt, ActivePointerV1? expectedFrom)
    {
        ArgumentNullException.ThrowIfNull(appReceipt); ArgumentNullException.ThrowIfNull(runtimeReceipt);
        InstalledAppManifestV1 app = ValidateReceipts(appReceipt, runtimeReceipt);
        ActivePointerV1? current = LocalActivationStore.RecoverAndReadCurrent(layout);
        if (!LocalActivationStore.Same(current, expectedFrom)) throw new StaleActivationException();
        if (current is not null && current.ActiveBuildId == app.BuildId && current.ActiveRuntimeId == app.RuntimeId)
        {
            appReceipt.ValidateForActivation(); runtimeReceipt.ValidateForActivation();
            return new ActivationReceipt(current, current, null, true);
        }
        using SmokeTemporaryTree temporary = CreateTemporaryDirectory();
        try
        {
            var request = new SmokeProcessRequest(BuildStartInfo(app, runtimeReceipt, temporary.Path), options.Timeout, options.HardTerminationTimeout);
            SmokeProcessResult result = options.ProcessLauncher is null ? DirectSmokeLauncher.Launch(appReceipt, runtimeReceipt, request) : options.ProcessLauncher.Launch(appReceipt, runtimeReceipt, request);
            SmokeActivationInfo smoke = ValidateSmoke(result, app);
            appReceipt.ValidateForActivation(); runtimeReceipt.ValidateForActivation();
            DateTimeOffset createdAt = clock();
            var activated = new ActivePointerV1(1, app.BuildId, app.RuntimeId, expectedFrom?.ActiveBuildId, expectedFrom?.ActiveRuntimeId, LauncherTime.Timestamp(createdAt));
            LocalActivationStore.Commit(layout, expectedFrom, activated, createdAt);
            return new ActivationReceipt(expectedFrom, activated, smoke, false);
        }
        finally { temporary.Cleanup(); }
    }

    private InstalledAppManifestV1 ValidateReceipts(InstalledArtifactReceipt appReceipt, InstalledArtifactReceipt runtimeReceipt)
    {
        appReceipt.ValidateForActivation(); runtimeReceipt.ValidateForActivation();
        if (appReceipt.Kind != "app" || appReceipt.Manifest is not InstalledAppManifestV1 app || appReceipt.Id != app.BuildId) throw new LocalSmokeActivationException("Invalid app installation receipt.");
        if (runtimeReceipt.Kind != "runtime" || runtimeReceipt.Manifest is not InstalledRuntimeManifestV1 runtime || runtimeReceipt.Id != runtime.RuntimeId) throw new LocalSmokeActivationException("Invalid runtime installation receipt.");
        if (app.RuntimeId != runtime.RuntimeId) throw new LocalSmokeActivationException("App and runtime receipts do not match.");
        RequireExactPath(appReceipt.FinalPath, Path.Combine(layout.Apps, app.BuildId), "app"); RequireExactPath(runtimeReceipt.FinalPath, Path.Combine(layout.Runtimes, runtime.RuntimeId), "runtime");
        return app;
    }

    private ProcessStartInfo BuildStartInfo(InstalledAppManifestV1 app, InstalledArtifactReceipt runtimeReceipt, string temporary)
    {
        var info = new ProcessStartInfo(Path.GetFullPath(Path.Combine(layout.Apps, app.BuildId, app.Entrypoint))) { UseShellExecute = false, WorkingDirectory = Path.Combine(layout.Apps, app.BuildId), RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        info.ArgumentList.Add("--update-smoke-test"); info.ArgumentList.Add("--launcher-build-id"); info.ArgumentList.Add(app.BuildId); info.ArgumentList.Add("--user-data-dir=" + temporary); info.ArgumentList.Add("--disable-gpu");
        foreach (string key in info.Environment.Keys.Where(static key => key.StartsWith("MAGICPOT_UPDATE_", StringComparison.OrdinalIgnoreCase)).ToArray()) info.Environment.Remove(key);
        info.Environment["MAGICPOT_LAUNCHER_ROOT"] = layout.Root; info.Environment["MAGICPOT_ACTIVE_VERSION"] = app.Version; info.Environment["MAGICPOT_ACTIVE_BUILD"] = app.BuildId; info.Environment["MAGICPOT_ACTIVE_BUILD_ID"] = app.BuildId;
        info.Environment["MAGICPOT_ACTIVE_RUNTIME"] = app.RuntimeId; info.Environment["MAGICPOT_ACTIVE_RUNTIME_ID"] = app.RuntimeId; info.Environment["MAGICPOT_LAUNCH_BUILD_ID"] = app.BuildId;
        info.Environment["MAGICPOT_LAUNCH_RUNTIME_ID"] = app.RuntimeId; info.Environment["MAGICPOT_RUNTIME_DIR"] = runtimeReceipt.FinalPath;
        return info;
    }

    private static SmokeActivationInfo ValidateSmoke(SmokeProcessResult result, InstalledAppManifestV1 app)
    {
        if (result.StdoutExceeded) throw new LocalSmokeActivationException("Smoke process standard output exceeded 1 MiB.");
        if (result.StderrExceeded) throw new LocalSmokeActivationException("Smoke process standard error exceeded 1 MiB.");
        if (result.TimedOut) throw new LocalSmokeActivationException("Smoke process timed out.");
        if (result.ExitCode != 0) throw new LocalSmokeActivationException("Smoke process exited with code " + result.ExitCode.ToString(CultureInfo.InvariantCulture) + ".");
        string? line = result.StandardOutput.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).LastOrDefault();
        if (line is null) throw new LocalSmokeActivationException("Smoke process produced no result JSON.");
        try
        {
            using JsonDocument document = JsonDocument.Parse(line); JsonElement root = document.RootElement;
            string[] names = root.ValueKind == JsonValueKind.Object ? root.EnumerateObject().Select(static property => property.Name).ToArray() : [];
            if (names.Length != 3 || !names.Contains("ok") || !names.Contains("version") || !names.Contains("buildId") || root.GetProperty("ok").ValueKind != JsonValueKind.True) throw new JsonException("Unexpected smoke schema.");
            string? version = root.GetProperty("version").GetString(); string? buildId = root.GetProperty("buildId").GetString();
            if (version != app.Version || buildId != app.BuildId) throw new LocalSmokeActivationException("Smoke identity does not match the app receipt.");
            return new SmokeActivationInfo(version, buildId, result.ExitCode, result.StandardOutput, result.StandardError);
        }
        catch (LocalSmokeActivationException) { throw; }
        catch (Exception error) when (error is JsonException or InvalidOperationException) { throw new LocalSmokeActivationException("Smoke result JSON is malformed.", error); }
    }

    private SmokeTemporaryTree CreateTemporaryDirectory()
    {
        string root = options.TemporaryRoot is null ? Path.Combine(layout.Root, "smoke-state") : Path.GetFullPath(options.TemporaryRoot);
        if (!IsContained(layout.Root, root)) throw new LocalSmokeActivationException("Smoke temporary root must be under launcher root.");
        string relative = Path.GetRelativePath(layout.Root, root);
        if (relative is "." or "" || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)) throw new LocalSmokeActivationException("Smoke temporary root must be under launcher root.");
        try
        {
            var chain = new InstallAncestorChain(layout.Root, relative);
            try
            {
                string path = Path.Combine(root, Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture));
                chain.CreateExclusive(path);
                return SmokeTemporaryTree.Open(path, chain, chain.CanonicalContainer);
            }
            catch { chain.Dispose(); throw; }
        }
        catch (PreparedArtifactInstallationException error) { throw new LocalSmokeActivationException("Could not create a pinned smoke temporary directory.", error); }
    }
    private static void RequireExactPath(string actual, string expected, string label) { if (!string.Equals(Path.TrimEndingDirectorySeparator(Path.GetFullPath(actual)), Path.TrimEndingDirectorySeparator(Path.GetFullPath(expected)), StringComparison.OrdinalIgnoreCase)) throw new LocalSmokeActivationException(label + " receipt final path does not match launcher layout."); }
    private static bool IsContained(string root, string path) { string prefix = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)) + Path.DirectorySeparatorChar; return Path.GetFullPath(path).StartsWith(prefix, StringComparison.OrdinalIgnoreCase); }
}

internal sealed class SmokeTemporaryTree : IDisposable
{
    private readonly InstallAncestorChain chain;
    private readonly InstallPinnedTree tree;
    private readonly string allowedRootCanonical;
    private bool cleaned;
    private SmokeTemporaryTree(InstallAncestorChain chain, InstallPinnedTree tree, string allowedRootCanonical) { this.chain = chain; this.tree = tree; this.allowedRootCanonical = InstallNative.Normalize(allowedRootCanonical); }
    internal string Path => tree.Root;
    internal string? CleanupPendingReason { get; private set; }
    internal static SmokeTemporaryTree Open(string path, InstallAncestorChain chain) => Open(path, chain, chain.CanonicalContainer);
    internal static SmokeTemporaryTree Open(string path, InstallAncestorChain chain, string allowedRootCanonical) => new(chain, InstallPinnedTree.CreatePartial(path, chain, null), allowedRootCanonical);
    internal void Cleanup()
    {
        if (cleaned) return;
        cleaned = true;
        try
        {
            if (!tree.TryResolvePinnedRootPathWithin(allowedRootCanonical, out string actualPath))
            {
                CleanupPendingReason = "Pinned smoke root could not be resolved beneath the allowed smoke root; cleanup orphan preserved.";
                Debug.WriteLine("SECURITY CLEANUP TICKET: " + CleanupPendingReason);
                tree.AbandonCleanup();
                return;
            }
            tree.EnumerateAndPinAt(actualPath);
            tree.ValidatePinnedAll();
            tree.Cleanup();
        }
        catch (PreparedArtifactInstallationException error)
        {
            CleanupPendingReason = "Pinned smoke cleanup failed; orphan preserved: " + error.Message;
            Debug.WriteLine("SECURITY CLEANUP TICKET: " + CleanupPendingReason);
            tree.AbandonCleanup();
        }
        finally { chain.Dispose(); }
    }
    public void Dispose() => Cleanup();
}

internal sealed record BoundedOutput(string Text, bool Exceeded);

internal static class DirectSmokeLauncher
{
    private const int MaximumCaptureBytes = 1024 * 1024;
    internal static SmokeProcessResult Launch(InstalledArtifactReceipt appReceipt, InstalledArtifactReceipt runtimeReceipt, SmokeProcessRequest request)
    {
        appReceipt.ValidateImmediatelyBeforeLaunch();
        runtimeReceipt.ValidateImmediatelyBeforeLaunch();
        using Process process = Process.Start(request.StartInfo) ?? throw new LocalSmokeActivationException("Smoke process did not start.");
        using var readerCancellation = new CancellationTokenSource();
        Stream stdoutStream = process.StandardOutput.BaseStream;
        Stream stderrStream = process.StandardError.BaseStream;
        Task<BoundedOutput> stdout = ReadBoundedAsync(stdoutStream, MaximumCaptureBytes, readerCancellation.Token);
        Task<BoundedOutput> stderr = ReadBoundedAsync(stderrStream, MaximumCaptureBytes, readerCancellation.Token);
        bool exitedNormally = process.WaitForExit(ToWaitMilliseconds(request.Timeout));
        Exception? killError = null;
        if (!exitedNormally)
        {
            try { process.Kill(entireProcessTree: true); }
            catch (Exception error) { killError = error; }
        }

        var hardWait = Stopwatch.StartNew();
        bool processExited = HasExited(process) || process.WaitForExit(RemainingMilliseconds(request.HardTerminationTimeout, hardWait.Elapsed));
        Task readers = Task.WhenAll(stdout, stderr);
        int readerWait = RemainingMilliseconds(request.HardTerminationTimeout, hardWait.Elapsed);
        bool readersCompleted = readers.IsCompleted || Task.WhenAny(readers, Task.Delay(readerWait)).GetAwaiter().GetResult() == readers;
        if (killError is not null || !processExited || !readersCompleted)
        {
            readerCancellation.Cancel();
            try { stdoutStream.Dispose(); } catch { }
            try { stderrStream.Dispose(); } catch { }
            if (!processExited) try { process.Dispose(); } catch { }
            string reason = killError is not null ? "Smoke process tree termination failed." : !processExited ? "Smoke process did not exit before the hard termination deadline." : "Smoke output readers did not complete before the hard termination deadline.";
            throw new LocalSmokeActivationException(reason, killError ?? new TimeoutException(reason));
        }

        try { readers.GetAwaiter().GetResult(); }
        catch (Exception error) when (error is not LocalSmokeActivationException) { throw new LocalSmokeActivationException("Smoke output could not be read as strict UTF-8.", error); }
        BoundedOutput standardOutput = stdout.GetAwaiter().GetResult(); BoundedOutput standardError = stderr.GetAwaiter().GetResult();
        return new SmokeProcessResult(exitedNormally ? process.ExitCode : -1, !exitedNormally, standardOutput.Text, standardError.Text, standardOutput.Exceeded, standardError.Exceeded);
    }

    private static int ToWaitMilliseconds(TimeSpan timeout) => Math.Max(1, checked((int)Math.Min(Math.Ceiling(timeout.TotalMilliseconds), int.MaxValue)));
    private static int RemainingMilliseconds(TimeSpan timeout, TimeSpan elapsed) => Math.Max(0, checked((int)Math.Min(Math.Ceiling((timeout - elapsed).TotalMilliseconds), int.MaxValue)));
    private static bool HasExited(Process process) { try { return process.HasExited; } catch { return false; } }

    internal static async Task<BoundedOutput> ReadBoundedAsync(Stream stream, int maximumBytes, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(stream);
        if (maximumBytes < 0) throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        byte[] captured = new byte[checked(maximumBytes + 1)];
        byte[] buffer = new byte[8192];
        int capturedCount = 0;
        while (true)
        {
            int count = await stream.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false);
            if (count == 0) break;
            int copy = Math.Min(count, captured.Length - capturedCount);
            if (copy > 0) { buffer.AsSpan(0, copy).CopyTo(captured.AsSpan(capturedCount)); capturedCount += copy; }
        }
        bool exceeded = capturedCount > maximumBytes;
        int decodeCount = Math.Min(capturedCount, maximumBytes);
        if (exceeded) return new BoundedOutput(string.Empty, true);
        try { return new BoundedOutput(new UTF8Encoding(false, true).GetString(captured, 0, decodeCount), false); }
        catch (DecoderFallbackException error) { throw new LocalSmokeActivationException("Smoke output is not valid UTF-8.", error); }
    }
}

internal static class WindowsDllSearchHardening
{
    private const uint LoadLibrarySearchUserDirs = 0x00000400; private const uint LoadLibrarySearchSystem32 = 0x00000800;
    private static readonly object Gate = new(); private static int initialized;
    internal static bool IsInitialized => Volatile.Read(ref initialized) == 1;
    internal static void EnsureInitialized()
    {
        if (IsInitialized) return;
        lock (Gate)
        {
            if (initialized != 0) { if (initialized < 0) throw new LocalSmokeActivationException("DLL search hardening previously failed."); return; }
            if (!SetDefaultDllDirectories(LoadLibrarySearchSystem32 | LoadLibrarySearchUserDirs) || !SetDllDirectoryW(string.Empty)) { initialized = -1; throw new LocalSmokeActivationException("DLL search hardening failed.", new Win32Exception(Marshal.GetLastWin32Error())); }
            Volatile.Write(ref initialized, 1);
        }
    }
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetDefaultDllDirectories(uint directoryFlags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetDllDirectoryW(string pathName);
}

internal static class LocalActivationStore
{
    internal static ActivePointerV1? ReadCurrent(LauncherLayout layout) => Execute(() => { using var scope = new ActivationStateTransactionScope(layout); return scope.SafeReadJson(layout.ActivePointer, Protocol.ParseActivePointer); });
    internal static ActivePointerV1? RecoverAndReadCurrent(LauncherLayout layout) => Execute(() =>
    {
        using var scope = new ActivationStateTransactionScope(layout);
        RecoverLocked(scope, layout);
        return scope.SafeReadJson(layout.ActivePointer, Protocol.ParseActivePointer);
    });
    internal static void Commit(LauncherLayout layout, ActivePointerV1? from, ActivePointerV1 to, DateTimeOffset createdAt) => Execute(() =>
    {
        using var scope = new ActivationStateTransactionScope(layout);
        RecoverLocked(scope, layout);
        ActivePointerV1? actualCurrent = scope.SafeReadJson(layout.ActivePointer, Protocol.ParseActivePointer);
        if (Same(actualCurrent, to)) return;
        if (!Same(actualCurrent, from)) throw new StaleActivationException();
        CommitLocked(scope, layout, actualCurrent, to, createdAt);
    });
    internal static void RepairInvalidCurrent(LauncherLayout layout, ActivePointerV1 to, DateTimeOffset? createdAt = null) => Execute(() =>
    {
        using var scope = new ActivationStateTransactionScope(layout);
        RecoverLocked(scope, layout);
        ActivePointerV1 repair = createdAt is null ? to : to with { ActivatedAt = LauncherTime.Timestamp(createdAt.Value) };
        RepairCurrentRead current = scope.TryReadCurrentForRepair(layout.ActivePointer);
        if (current.Pointer is not null)
        {
            if (!Same(current.Pointer, repair)) throw new StaleActivationException();
            scope.SafeAtomicWrite(layout.Health, new LauncherHealthStateV1(1, 0), Protocol.ParseHealth);
            scope.SafeDelete(layout.ActivationJournal);
            return;
        }
        scope.SafeAtomicWrite(layout.ActivePointer, repair, Protocol.ParseActivePointer);
        scope.SafeAtomicWrite(layout.Health, new LauncherHealthStateV1(1, 0), Protocol.ParseHealth);
        scope.SafeDelete(layout.ActivationJournal);
    });
    internal static void Recover(LauncherLayout layout) => Execute(() => { using var scope = new ActivationStateTransactionScope(layout); RecoverLocked(scope, layout); });
    private static void CommitLocked(ActivationStateTransactionScope scope, LauncherLayout layout, ActivePointerV1? from, ActivePointerV1 to, DateTimeOffset createdAt)
    {
        scope.SafeAtomicWrite(layout.ActivationJournal, new ActivationJournalV1(1, "prepared", LauncherTime.Timestamp(createdAt), from, to), ParseJournal);
        scope.SafeAtomicWrite(layout.ActivePointer, to, Protocol.ParseActivePointer);
        scope.SafeAtomicWrite(layout.Health, new LauncherHealthStateV1(1, 0), Protocol.ParseHealth);
        scope.SafeDelete(layout.ActivationJournal);
    }
    private static void RecoverLocked(ActivationStateTransactionScope scope, LauncherLayout layout)
    {
        ActivationJournalV1? journal = scope.SafeReadJson(layout.ActivationJournal, ParseJournal); if (journal is null) return;
        ActivePointerV1? current = scope.SafeReadJson(layout.ActivePointer, Protocol.ParseActivePointer);
        if (Same(current, journal.To)) { scope.SafeAtomicWrite(layout.Health, new LauncherHealthStateV1(1, 0), Protocol.ParseHealth); scope.SafeDelete(layout.ActivationJournal); return; }
        if (Same(current, journal.From)) { scope.SafeDelete(layout.ActivationJournal); return; }
        throw new InvalidOperationException("Active pointer is inconsistent with the pending activation journal");
    }
    private static T Execute<T>(Func<T> action)
    {
        try { return action(); }
        catch (LocalSmokeActivationException) { throw; }
        catch (OperationCanceledException) { throw; }
        catch (Exception error)
        {
            throw new LocalSmokeActivationException("Local activation transaction failed.", error);
        }
    }
    private static void Execute(Action action) => Execute(() => { action(); return true; });
    internal static bool Same(ActivePointerV1? left, ActivePointerV1? right) => left is null ? right is null : right is not null && left.ActiveBuildId == right.ActiveBuildId && left.ActiveRuntimeId == right.ActiveRuntimeId && left.PreviousBuildId == right.PreviousBuildId && left.PreviousRuntimeId == right.PreviousRuntimeId && left.ActivatedAt == right.ActivatedAt;
    private static ActivationJournalV1 ParseJournal(string text)
    {
        using JsonDocument document = JsonDocument.Parse(text); JsonElement root = document.RootElement; string[] names = root.EnumerateObject().Select(static property => property.Name).ToArray();
        if (names.Length is < 4 or > 5 || !names.Contains("schema") || !names.Contains("phase") || !names.Contains("createdAt") || !names.Contains("to") || root.GetProperty("schema").GetInt32() != 1 || root.GetProperty("phase").GetString() != "prepared") throw new ProtocolException("activation journal does not match schema 1");
        ActivePointerV1? from = root.TryGetProperty("from", out JsonElement fromElement) ? Protocol.ParseActivePointer(fromElement.GetRawText()) : null; ActivePointerV1 to = Protocol.ParseActivePointer(root.GetProperty("to").GetRawText());
        return new ActivationJournalV1(1, "prepared", root.GetProperty("createdAt").GetString() ?? throw new ProtocolException("Missing journal timestamp"), from, to);
    }
}

internal sealed record RepairCurrentRead(ActivePointerV1? Pointer, bool InvalidContent);

internal sealed class ActivationStateTransactionScope : IDisposable
{
    private const int ErrorFileNotFound = 2, ErrorPathNotFound = 3;
    private const int FileRenameInfo = 3;
    internal static Action<string>? BeforeHandleRename { get; set; }
    internal static Action<string>? BeforeDeleteDisposition { get; set; }
    internal static Action<string>? AfterClose { get; set; }
    private readonly LauncherLayout layout;
    private readonly List<SafeFileHandle> ancestors = [];
    private readonly UpdateFileLock updateLock;

    internal ActivationStateTransactionScope(LauncherLayout layout)
    {
        this.layout = layout;
        try
        {
            Directory.CreateDirectory(layout.HealthLock);
            PinAncestors(layout.HealthLock);
            updateLock = UpdateFileLock.Acquire(layout.HealthLock, timeout: TimeSpan.FromSeconds(5), stale: UpdateFileLock.HealthLockStale);
        }
        catch
        {
            for (int i = ancestors.Count - 1; i >= 0; i--) ancestors[i].Dispose();
            throw;
        }
    }

    internal T? SafeReadJson<T>(string path, Func<string, T> parse) where T : class
    {
        RequireStatePath(path);
        SafeFileHandle handle = InstallNative.CreateFileW(path, InstallNative.GenericRead, FileShare.Read, IntPtr.Zero, FileMode.Open, InstallNative.OpenReparse, IntPtr.Zero);
        if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); if (error is ErrorFileNotFound or ErrorPathNotFound) return null; throw new Win32Exception(error, "Safe activation state open failed."); }
        using (handle) { InstallNative.ValidateFile(handle, path); using var stream = new FileStream(handle, FileAccess.Read); using var reader = new StreamReader(stream, new UTF8Encoding(false, true), false); return parse(reader.ReadToEnd()); }
    }

    internal RepairCurrentRead TryReadCurrentForRepair(string path)
    {
        RequireStatePath(path);
        SafeFileHandle handle = InstallNative.CreateFileW(path, InstallNative.GenericRead, FileShare.Read, IntPtr.Zero, FileMode.Open, InstallNative.OpenReparse, IntPtr.Zero);
        if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); if (error is ErrorFileNotFound or ErrorPathNotFound) return new(null, false); throw new Win32Exception(error, "Safe activation state open failed."); }
        using (handle)
        {
            InstallNative.ValidateFile(handle, path);
            using var stream = new FileStream(handle, FileAccess.Read);
            using var reader = new StreamReader(stream, new UTF8Encoding(false, true), false);
            string text = reader.ReadToEnd();
            try { return new(Protocol.ParseActivePointer(text), false); }
            catch (Exception error) when (error is ProtocolException or JsonException) { return new(null, true); }
        }
    }

    internal void SafeAtomicWrite<T>(string path, T value, Func<string, T> parse) where T : class
    {
        RequireStatePath(path); RejectSuspiciousExisting(path);
        string temp = Path.Combine(layout.Root, "." + Path.GetFileName(path) + ".tmp-" + Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture));
        SafeFileHandle handle = InstallNative.CreateFileW(temp, InstallNative.GenericRead | InstallNative.GenericWrite | InstallNative.Delete, FileShare.Read | FileShare.Delete, IntPtr.Zero, FileMode.CreateNew, InstallNative.Normal | InstallNative.OpenReparse | InstallNative.WriteThrough, IntPtr.Zero);
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Safe activation state temporary create failed.");
        using (handle)
        {
            InstallNative.ValidateFile(handle, temp);
            InstalledFileIdentity identity = InstallNative.Identity(handle);
            byte[] expected = new UTF8Encoding(false, true).GetBytes(Protocol.Serialize(value));
            bool published = false;
            try
            {
                RandomAccess.Write(handle, expected, 0);
                RandomAccess.FlushToDisk(handle);
                VerifyExactBytes(handle, expected, "temporary state");
                if (InstallNative.Identity(handle) != identity) throw new InvalidOperationException("Activation state temporary identity changed.");

                BeforeHandleRename?.Invoke(temp);
                HandleRenameToStatePath(handle, path);
                published = true;

                if (InstallNative.Identity(handle) != identity) throw new InvalidOperationException("Activation state renamed handle identity changed.");
                VerifyExactBytes(handle, expected, "renamed state handle");

                SafeFileHandle target = InstallNative.CreateFileW(path, InstallNative.GenericRead, FileShare.ReadWrite | FileShare.Delete, IntPtr.Zero, FileMode.Open, InstallNative.OpenReparse, IntPtr.Zero);
                if (target.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Safe activation state verification open failed.");
                using (target)
                {
                    InstallNative.ValidateFile(target, path);
                    if (InstallNative.Identity(target) != identity) throw new InvalidOperationException("Activation state replacement identity changed.");
                    byte[] actual = VerifyExactBytes(target, expected, "activation state target");
                    _ = parse(new UTF8Encoding(false, true).GetString(actual));
                }
            }
            finally
            {
                if (!published)
                {
                    try { if (InstallNative.Identity(handle) == identity) InstallNative.DeleteByHandle(handle); }
                    catch (Exception error) { Debug.WriteLine("SECURITY CLEANUP TICKET: activation state temporary handle cleanup failed: " + error.Message); }
                }
            }
        }
    }

    private void HandleRenameToStatePath(SafeFileHandle handle, string target)
    {
        RequireStatePath(target);
        string targetPath = Path.GetFullPath(target);
        byte[] name = Encoding.Unicode.GetBytes(targetPath);
        int rootOffset = IntPtr.Size == 8 ? 8 : 4;
        int lengthOffset = IntPtr.Size == 8 ? 16 : 8;
        int nameOffset = IntPtr.Size == 8 ? 20 : 12;
        int bufferLength = checked(nameOffset + name.Length + sizeof(char));
        IntPtr buffer = Marshal.AllocHGlobal(bufferLength);
        try
        {
            for (int i = 0; i < bufferLength; i++) Marshal.WriteByte(buffer, i, 0);
            Marshal.WriteInt32(buffer, 0, 1);
            Marshal.WriteIntPtr(buffer, rootOffset, IntPtr.Zero);
            Marshal.WriteInt32(buffer, lengthOffset, name.Length);
            Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
            // Local Windows micro-tests require the trailing UTF-16 NUL; relative RootDirectory renames return Win32 error 87 on this host.
            if (!SetFileInformationByHandle(handle, FileRenameInfo, buffer, checked((uint)bufferLength))) throw new Win32Exception(Marshal.GetLastWin32Error(), "Safe activation state handle rename failed.");
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static byte[] VerifyExactBytes(SafeFileHandle handle, byte[] expected, string label)
    {
        long length = RandomAccess.GetLength(handle);
        if (length != expected.Length) throw new InvalidOperationException(label + " length changed.");
        byte[] actual = new byte[expected.Length];
        int read = 0;
        while (read < actual.Length)
        {
            int count = RandomAccess.Read(handle, actual.AsSpan(read), read);
            if (count == 0) throw new EndOfStreamException(label + " ended before its recorded length.");
            read += count;
        }
        if (!CryptographicOperations.FixedTimeEquals(expected, actual)) throw new InvalidOperationException(label + " bytes changed.");
        return actual;
    }

    internal void SafeDelete(string path)
    {
        RequireStatePath(path);
        SafeFileHandle first = InstallNative.CreateFileW(path, InstallNative.GenericRead | InstallNative.Delete, FileShare.Read, IntPtr.Zero, FileMode.Open, InstallNative.OpenReparse, IntPtr.Zero);
        if (first.IsInvalid) { int error = Marshal.GetLastWin32Error(); first.Dispose(); if (error is ErrorFileNotFound or ErrorPathNotFound) return; throw new Win32Exception(error, "Safe state delete open failed."); }
        using (first)
        {
            InstallNative.ValidateFile(first, path);
            BeforeDeleteDisposition?.Invoke(path);
            InstallNative.DeleteByHandle(first);
        }
        AfterClose?.Invoke(path);
        if (File.Exists(path) || Directory.Exists(path))
        {
            try
            {
                if (Directory.Exists(path))
                {
                    using SafeFileHandle replacement = InstallNative.OpenDirectory(path, InstallNative.ReadAttributes, FileShare.Read);
                    InstallNative.ValidateDirectory(replacement, path);
                }
                else
                {
                    SafeFileHandle replacement = InstallNative.CreateFileW(path, InstallNative.GenericRead, FileShare.Read, IntPtr.Zero, FileMode.Open, InstallNative.OpenReparse, IntPtr.Zero);
                    if (replacement.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                    using (replacement) InstallNative.ValidateFile(replacement, path);
                }
            }
            catch (Exception error) when (error is not LocalSmokeActivationException) { throw new LocalSmokeActivationException("Activation journal deletion incomplete.", error); }
            throw new LocalSmokeActivationException("Activation journal deletion incomplete.");
        }
    }

    private void PinAncestors(string target) { string normalized = InstallNative.Normalize(target); string volume = Path.GetPathRoot(normalized) ?? throw new InvalidOperationException("Activation root has no volume."); string current = volume; Pin(current); foreach (string part in normalized[volume.Length..].Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)) { if (part.Length == 0) continue; current = Path.Combine(current, part); Pin(current); } }
    private void Pin(string path) { SafeFileHandle handle = InstallNative.OpenDirectory(path, InstallNative.ReadAttributes, FileShare.ReadWrite); try { InstallNative.ValidateDirectory(handle, path); ancestors.Add(handle); } catch { handle.Dispose(); throw; } }
    private void RequireStatePath(string path) { bool allowed = string.Equals(path, layout.ActivePointer, StringComparison.OrdinalIgnoreCase) || string.Equals(path, layout.ActivationJournal, StringComparison.OrdinalIgnoreCase) || string.Equals(path, layout.Health, StringComparison.OrdinalIgnoreCase); if (!allowed || !string.Equals(Path.GetDirectoryName(InstallNative.Normalize(path)), InstallNative.Normalize(layout.Root), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Activation state path is not an allowed direct child."); }
    private static void RejectSuspiciousExisting(string path) { SafeFileHandle handle = InstallNative.CreateFileW(path, InstallNative.GenericRead, FileShare.Read, IntPtr.Zero, FileMode.Open, InstallNative.OpenReparse, IntPtr.Zero); if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); if (error is ErrorFileNotFound or ErrorPathNotFound) return; throw new Win32Exception(error, "Existing activation state inspection failed."); } using (handle) InstallNative.ValidateFile(handle, path); }
    public void Dispose() { updateLock.Dispose(); for (int i = ancestors.Count - 1; i >= 0; i--) ancestors[i].Dispose(); }
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetFileInformationByHandle(SafeFileHandle file, int informationClass, IntPtr information, uint bufferSize);
}
