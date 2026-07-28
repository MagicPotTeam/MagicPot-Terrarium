using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace MagicPot.Launcher;

internal sealed class InstalledLaunchLease : IDisposable
{
    private InstalledTreeVerifier? appVerifier;
    private InstalledTreeVerifier? runtimeVerifier;
    private readonly InstalledSelection selection;

    private InstalledLaunchLease(InstalledSelection selection, InstalledTreeVerifier appVerifier, InstalledTreeVerifier runtimeVerifier)
    {
        this.selection = selection;
        this.appVerifier = appVerifier;
        this.runtimeVerifier = runtimeVerifier;
    }

    internal static InstalledLaunchLease Acquire(LauncherLayout layout, InstalledSelection selection)
    {
        ArgumentNullException.ThrowIfNull(layout);
        ArgumentNullException.ThrowIfNull(selection);
        RequireManifestFiles(selection.Installation.App.Files, "app");
        RequireManifestFiles(selection.Installation.Runtime.Files, "runtime");
        if (selection.Pointer.ActiveBuildId != selection.Installation.App.BuildId || selection.Pointer.ActiveRuntimeId != selection.Installation.Runtime.RuntimeId || selection.Installation.App.RuntimeId != selection.Installation.Runtime.RuntimeId) throw new IOException("Installed launch selection identities do not match");
        RequirePath(selection.Installation.AppDirectory, Path.Combine(layout.Apps, selection.Installation.App.BuildId), "app");
        RequirePath(selection.Installation.RuntimeDirectory, Path.Combine(layout.Runtimes, selection.Installation.Runtime.RuntimeId), "runtime");
        InstalledTreeVerifier? app = null;
        InstalledTreeVerifier? runtime = null;
        try
        {
            app = Open(selection.Installation.AppDirectory, selection.Installation.App.Files!);
            runtime = Open(selection.Installation.RuntimeDirectory, selection.Installation.Runtime.Files!);
            var lease = new InstalledLaunchLease(selection, app, runtime);
            app = null;
            runtime = null;
            lease.ValidateImmediatelyBeforeLaunch();
            return lease;
        }
        catch { app?.Dispose(); runtime?.Dispose(); throw; }
    }

    internal void ValidateImmediatelyBeforeLaunch() => ValidateRuntimeIntegrity();

    internal void ValidateRuntimeIntegrity()
    {
        InstalledTreeVerifier app = appVerifier ?? throw new ObjectDisposedException(nameof(InstalledLaunchLease));
        InstalledTreeVerifier runtime = runtimeVerifier ?? throw new ObjectDisposedException(nameof(InstalledLaunchLease));
        app.ValidateForActivation(); runtime.ValidateForActivation();
        ValidateAppManifest(app, selection.Installation.App);
        ValidateRuntimeManifest(runtime, selection.Installation.Runtime);
        ValidateFiles(app, selection.Installation.App.Files!, selection.Installation.App.Entrypoint);
        ValidateFiles(runtime, selection.Installation.Runtime.Files!, selection.Installation.Runtime.Entrypoints.Python, selection.Installation.Runtime.Entrypoints.Comfyui);
    }

    private static InstalledTreeVerifier Open(string root, IReadOnlyList<InstalledFileV1> files)
    {
        var expectedFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (InstalledFileV1 file in files)
            if (!expectedFiles.Add(Normalize(file.Path))) throw new IOException("Duplicate installed manifest file path: " + file.Path);
        if (!expectedFiles.Add("manifest.json")) throw new IOException("manifest.json must not be listed in installed manifest files");
        var expectedDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string file in expectedFiles)
        {
            string? parent = Path.GetDirectoryName(file.Replace('/', Path.DirectorySeparatorChar));
            while (!string.IsNullOrEmpty(parent)) { expectedDirectories.Add(parent.Replace('\\', '/')); parent = Path.GetDirectoryName(parent); }
        }
        InstalledTreeVerifier verifier = InstalledTreeVerifier.Open(root, expectedFiles, expectedDirectories);
        verifier.CaptureActivationBaseline();
        return verifier;
    }

    private static void ValidateAppManifest(InstalledTreeVerifier verifier, InstalledAppManifestV1 expected)
    {
        using Stream stream = verifier.OpenRead("manifest.json"); using var reader = new StreamReader(stream, Encoding.UTF8, true);
        InstalledAppManifestV1 actual = Protocol.ParseAppManifest(reader.ReadToEnd());
        if (actual.Schema != expected.Schema || actual.Kind != expected.Kind || actual.Version != expected.Version || actual.BuildId != expected.BuildId || actual.CommitSha != expected.CommitSha || actual.Platform != expected.Platform || actual.Arch != expected.Arch || actual.RuntimeId != expected.RuntimeId || !SamePath(actual.Entrypoint, expected.Entrypoint) || actual.CreatedAt != expected.CreatedAt || actual.UnpackedSize != expected.UnpackedSize || !SameFiles(actual.Files, expected.Files)) throw new IOException("Pinned app manifest identity changed");
    }

    private static void ValidateRuntimeManifest(InstalledTreeVerifier verifier, InstalledRuntimeManifestV1 expected)
    {
        using Stream stream = verifier.OpenRead("manifest.json"); using var reader = new StreamReader(stream, Encoding.UTF8, true);
        InstalledRuntimeManifestV1 actual = Protocol.ParseRuntimeManifest(reader.ReadToEnd());
        if (actual.Schema != expected.Schema || actual.Kind != expected.Kind || actual.RuntimeId != expected.RuntimeId || actual.Platform != expected.Platform || actual.Arch != expected.Arch || actual.CreatedAt != expected.CreatedAt || actual.UnpackedSize != expected.UnpackedSize || !SamePath(actual.Entrypoints.Python, expected.Entrypoints.Python) || !SamePath(actual.Entrypoints.Comfyui, expected.Entrypoints.Comfyui) || !SameFiles(actual.Files, expected.Files)) throw new IOException("Pinned runtime manifest identity changed");
    }

    private static void ValidateFiles(InstalledTreeVerifier verifier, IReadOnlyList<InstalledFileV1> files, params string[] entrypoints)
    {
        var map = files.ToDictionary(static file => Normalize(file.Path), StringComparer.OrdinalIgnoreCase);
        foreach (string entrypoint in entrypoints) if (!map.ContainsKey(Normalize(entrypoint))) throw new IOException("Entrypoint is not present in installed manifest files");
        foreach (InstalledFileV1 expected in files)
        {
            using Stream stream = verifier.OpenRead(Normalize(expected.Path));
            if (stream.Length != expected.Size) throw new IOException("Pinned installed file length mismatch: " + expected.Path);
            if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(stream), Convert.FromHexString(expected.Sha256))) throw new IOException("Pinned installed file hash mismatch: " + expected.Path);
        }
    }

    private static bool SameFiles(IReadOnlyList<InstalledFileV1>? left, IReadOnlyList<InstalledFileV1>? right)
    {
        if (left is null || right is null || left.Count != right.Count) return false;
        var map = left.ToDictionary(static file => Normalize(file.Path), StringComparer.OrdinalIgnoreCase);
        return right.All(file => map.TryGetValue(Normalize(file.Path), out InstalledFileV1? item) && item.Size == file.Size && string.Equals(item.Sha256, file.Sha256, StringComparison.OrdinalIgnoreCase));
    }

    private static void RequireManifestFiles(IReadOnlyList<InstalledFileV1>? files, string kind)
    {
        if (files is null || files.Count == 0) throw new IOException($"Installed {kind} manifest files must be non-empty for launch");
        _ = files.ToDictionary(static file => Normalize(file.Path), StringComparer.OrdinalIgnoreCase);
    }

    private static void RequirePath(string actual, string expected, string kind)
    {
        if (!string.Equals(InstallNative.Normalize(actual), InstallNative.Normalize(expected), StringComparison.OrdinalIgnoreCase)) throw new IOException($"Installed {kind} path is not bound to the launcher layout");
    }

    private static string Normalize(string path) => path.Replace('\\', '/');
    private static bool SamePath(string left, string right) => string.Equals(Normalize(left), Normalize(right), StringComparison.OrdinalIgnoreCase);
    public void Dispose() { appVerifier?.Dispose(); appVerifier = null; runtimeVerifier?.Dispose(); runtimeVerifier = null; }
}

public sealed class LauncherProcessTerminationException : Exception
{
    internal LauncherProcessTerminationException(int processId, IReadOnlyList<Exception> errors)
        : base($"Launcher could not confirm termination of process {processId}", errors.Count == 0 ? null : new AggregateException(errors)) => ProcessId = processId;

    public int ProcessId { get; }
}

internal static class ProcessTreeTermination
{
    private const uint FatalExitCode = 0xDEAD;
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(25);

    internal static void TerminateAndWait(ControlledProcess controlledProcess, TimeSpan? softTimeout = null, TimeSpan? hardTimeout = null)
    {
        ArgumentNullException.ThrowIfNull(controlledProcess);
        Process process = controlledProcess.Process;
        TimeSpan soft = softTimeout ?? TimeSpan.FromSeconds(5);
        TimeSpan hard = hardTimeout ?? TimeSpan.FromSeconds(2);
        if (soft < TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(softTimeout));
        if (hard < TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(hardTimeout));
        var errors = new List<Exception>();
        int processId;
        try { processId = process.Id; }
        catch (Exception error) { throw new LauncherProcessTerminationException(0, [error]); }

        bool jobTerminationSucceeded = TryTerminateJob(controlledProcess, errors);
        if (WaitForEmpty(controlledProcess, soft, errors) && jobTerminationSucceeded) return;
        if (!HasExited(process, errors))
        {
            try
            {
                if (!TerminateProcess(controlledProcess.NativeProcessHandle, FatalExitCode)) errors.Add(new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "TerminateProcess failed"));
            }
            catch (Exception error) { errors.Add(error); }
        }
        if (WaitForEmpty(controlledProcess, hard, errors) && jobTerminationSucceeded) return;
        throw new LauncherProcessTerminationException(processId, errors);
    }

    internal static bool TryTerminateJob(ControlledProcess controlledProcess, List<Exception> errors)
    {
        try
        {
            if (TerminateJobObject(controlledProcess.JobHandle, FatalExitCode)) return true;
            errors.Add(new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "TerminateJobObject failed"));
        }
        catch (Exception error) { errors.Add(error); }
        return false;
    }

    private static bool HasExited(Process process, List<Exception> errors)
    {
        try { return process.HasExited; }
        catch (Exception error) { errors.Add(error); return false; }
    }

    private static bool WaitForEmpty(ControlledProcess controlledProcess, TimeSpan timeout, List<Exception> errors)
    {
        try { return controlledProcess.WaitForJobEmpty(timeout, PollInterval, CancellationToken.None); }
        catch (Exception error) { errors.Add(error); return false; }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(SafeProcessHandle process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(SafeJobHandle job, uint exitCode);
}

internal static class ProcessContainmentRegistry
{
    private static readonly ConcurrentDictionary<string, Entry> Guardians = new(StringComparer.Ordinal);
    private static readonly List<Entry> EmergencyEntries = [];
    private static readonly object EmergencyLock = new();
    internal static Func<string, bool>? RejectRegistrationForTesting { get; set; }

    internal static void RegisterNoThrow(ControlledProcess controlledProcess, InstalledLaunchLease lease)
    {
        Entry? entry = null;
        try
        {
            entry = new Entry(controlledProcess, lease);
            bool added = RejectRegistrationForTesting?.Invoke(entry.ContainmentId) != true && Guardians.TryAdd(entry.ContainmentId, entry);
            StartGuardianNoThrow(entry, added);
        }
        catch (Exception)
        {
            if (entry is not null) StartGuardianNoThrow(entry, registered: false);
            else EmergencyCleanupNoThrow(controlledProcess, lease);
        }
    }

    private static void StartGuardianNoThrow(Entry entry, bool registered)
    {
        Thread? thread = null;
        try
        {
            thread = new Thread(() => RunEntry(entry, registered))
            {
                IsBackground = true,
                Name = "MagicPot containment guardian"
            };
            thread.Start();
        }
        catch (Exception)
        {
            if (thread is not null)
            {
                try { if (!thread.ThreadState.HasFlag(System.Threading.ThreadState.Unstarted)) return; }
                catch (Exception) { }
            }
            if (registered) RemoveSelf(entry);
            EmergencyCleanupNoThrow(entry.ControlledProcess, entry.Lease, entry);
        }
    }

    private static void RunEntry(Entry entry, bool registered)
    {
        try
        {
            while (true)
            {
                var errors = new List<Exception>();
                ProcessTreeTermination.TryTerminateJob(entry.ControlledProcess, errors);
                try
                {
                    if (entry.ControlledProcess.WaitForJobEmpty(TimeSpan.FromSeconds(1), TimeSpan.FromMilliseconds(25), CancellationToken.None)) break;
                }
                catch (Exception) { }
                Thread.Sleep(TimeSpan.FromSeconds(1));
            }
            entry.DisposeResourcesNoThrow();
        }
        catch (Exception)
        {
            EmergencyCleanupNoThrow(entry.ControlledProcess, entry.Lease, entry);
        }
        finally
        {
            if (registered) RemoveSelf(entry);
        }
    }

    private static void RemoveSelf(Entry entry)
    {
        try { _ = ((ICollection<KeyValuePair<string, Entry>>)Guardians).Remove(new(entry.ContainmentId, entry)); }
        catch (Exception) { }
    }

    private static void EmergencyCleanupNoThrow(ControlledProcess controlledProcess, InstalledLaunchLease lease, Entry? entry = null)
    {
        try
        {
            var errors = new List<Exception>();
            ProcessTreeTermination.TryTerminateJob(controlledProcess, errors);
            try
            {
                if (controlledProcess.WaitForJobEmpty(TimeSpan.FromSeconds(2), TimeSpan.FromMilliseconds(25), CancellationToken.None))
                {
                    if (entry is not null) entry.DisposeResourcesNoThrow();
                    else
                    {
                        try { controlledProcess.Dispose(); } catch (Exception) { }
                        try { lease.Dispose(); } catch (Exception) { }
                    }
                    return;
                }
            }
            catch (Exception) { }
            try { controlledProcess.JobHandle.Dispose(); } catch (Exception) { }
        }
        catch (Exception) { }

        try
        {
            Entry retained = entry ?? new Entry(controlledProcess, lease);
            lock (EmergencyLock) EmergencyEntries.Add(retained);
        }
        catch (Exception) { }
    }

    private sealed class Entry
    {
        internal Entry(ControlledProcess controlledProcess, InstalledLaunchLease lease)
        {
            ControlledProcess = controlledProcess;
            Lease = lease;
            ContainmentId = controlledProcess.ContainmentId;
        }

        internal string ContainmentId { get; }
        internal ControlledProcess ControlledProcess { get; }
        internal InstalledLaunchLease Lease { get; }

        internal void DisposeResourcesNoThrow()
        {
            try { ControlledProcess.Dispose(); } catch (Exception) { }
            try { Lease.Dispose(); } catch (Exception) { }
        }
    }
}

internal sealed class SafeJobHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    private SafeJobHandle() : base(true) { }
    protected override bool ReleaseHandle() => CloseHandle(handle);
    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}

internal sealed class ControlledProcess : IDisposable
{
    internal static Func<string>? ContainmentIdFactoryForTesting { get; set; }

    internal ControlledProcess(Process process, SafeProcessHandle nativeProcessHandle, SafeJobHandle jobHandle, int processId, string? containmentId = null)
    {
        Process = process; NativeProcessHandle = nativeProcessHandle; JobHandle = jobHandle; ProcessId = processId;
        ContainmentId = containmentId ?? ContainmentIdFactoryForTesting?.Invoke() ?? Guid.NewGuid().ToString("N");
    }
    internal Process Process { get; }
    internal SafeProcessHandle NativeProcessHandle { get; }
    internal SafeJobHandle JobHandle { get; }
    internal int ProcessId { get; }
    internal string ContainmentId { get; }

    internal uint GetActiveProcessCount()
    {
        var information = new JobObjectBasicAccountingInformation();
        if (!QueryInformationJobObject(JobHandle, 1, ref information, (uint)Marshal.SizeOf<JobObjectBasicAccountingInformation>(), IntPtr.Zero))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "QueryInformationJobObject failed");
        return information.ActiveProcesses;
    }

    internal bool WaitForJobEmpty(TimeSpan timeout, TimeSpan pollInterval, CancellationToken cancellationToken)
    {
        if (timeout < TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(timeout));
        if (pollInterval <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(pollInterval));
        long deadline = Stopwatch.GetTimestamp() + (long)(timeout.TotalSeconds * Stopwatch.Frequency);
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (GetActiveProcessCount() == 0) return true;
            long now = Stopwatch.GetTimestamp();
            if (now >= deadline) return false;
            TimeSpan remaining = TimeSpan.FromSeconds((deadline - now) / (double)Stopwatch.Frequency);
            TimeSpan delay = remaining < pollInterval ? remaining : pollInterval;
            if (cancellationToken.WaitHandle.WaitOne(delay)) cancellationToken.ThrowIfCancellationRequested();
        }
    }

    public void Dispose()
    {
        uint activeProcesses = GetActiveProcessCount();
        Debug.Assert(activeProcesses == 0, "A controlled process job must be empty before disposal");
        if (activeProcesses != 0) throw new InvalidOperationException($"Cannot dispose non-empty process job ({activeProcesses} active processes)");
        JobHandle.Dispose(); Process.Dispose(); NativeProcessHandle.Dispose();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicAccountingInformation
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(SafeJobHandle job, int informationClass, ref JobObjectBasicAccountingInformation information, uint informationLength, IntPtr returnLength);
}

internal interface IInstalledProcessStarter { ControlledProcess Start(InstalledLaunchLease lease, ProcessStartInfo startInfo); }

internal sealed class DirectInstalledProcessStarter : IInstalledProcessStarter
{
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint CreateSuspended = 0x00000004;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private static readonly IntPtr ProcThreadAttributeMitigationPolicy = (IntPtr)0x00020007;
    // winnt.h: IMAGE_LOAD_NO_REMOTE=bit 52, NO_LOW_LABEL=bit 56, PREFER_SYSTEM32=bit 60.
    private const ulong ImageLoadNoRemoteAlwaysOn = 0x0010000000000000UL;
    private const ulong ImageLoadNoLowLabelAlwaysOn = 0x0100000000000000UL;
    private const ulong ImageLoadPreferSystem32AlwaysOn = 0x1000000000000000UL;

    public ControlledProcess Start(InstalledLaunchLease lease, ProcessStartInfo startInfo)
    {
        ArgumentNullException.ThrowIfNull(lease);
        ArgumentNullException.ThrowIfNull(startInfo);
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Hardened installed process creation requires Windows");
        if (!Path.IsPathFullyQualified(startInfo.FileName)) throw new InvalidOperationException("Installed executable path must be absolute");
        if (!Path.IsPathFullyQualified(startInfo.WorkingDirectory)) throw new InvalidOperationException("Installed working directory must be absolute");
        if (startInfo.UseShellExecute) throw new InvalidOperationException("Shell execution is not supported");
        lease.ValidateImmediatelyBeforeLaunch();

        IntPtr attributeList = IntPtr.Zero;
        IntPtr policyPointer = IntPtr.Zero;
        IntPtr environmentPointer = IntPtr.Zero;
        var attributeListInitialized = false;
        SafeJobHandle? job = null;
        SafeProcessHandle? nativeProcess = null;
        Process? process = null;
        IntPtr thread = IntPtr.Zero;
        try
        {
            nuint size = 0;
            _ = InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            if (size == 0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Mitigation attribute list sizing failed");
            IntPtr heap = GetProcessHeap();
            attributeList = HeapAlloc(heap, 0, size);
            if (attributeList == IntPtr.Zero) throw new OutOfMemoryException("Mitigation attribute list allocation failed");
            if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Mitigation attribute list initialization failed");
            attributeListInitialized = true;
            policyPointer = HeapAlloc(heap, 0, (nuint)sizeof(long));
            if (policyPointer == IntPtr.Zero) throw new OutOfMemoryException("Mitigation policy allocation failed");
            Marshal.WriteInt64(policyPointer, unchecked((long)(ImageLoadNoRemoteAlwaysOn | ImageLoadNoLowLabelAlwaysOn | ImageLoadPreferSystem32AlwaysOn)));
            if (!UpdateProcThreadAttribute(attributeList, 0, ProcThreadAttributeMitigationPolicy, policyPointer, (nuint)sizeof(long), IntPtr.Zero, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Child mitigation policy setup failed");

            byte[] environment = Encoding.Unicode.GetBytes(BuildEnvironmentBlock(startInfo));
            environmentPointer = Marshal.AllocHGlobal(environment.Length);
            Marshal.Copy(environment, 0, environmentPointer, environment.Length);
            var startup = new StartupInfoEx { StartupInfo = new StartupInfo { Cb = Marshal.SizeOf<StartupInfoEx>() }, AttributeList = attributeList };
            StringBuilder commandLine = BuildCommandLine(startInfo);
            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObjectW failed");
            var limits = new JobObjectExtendedLimitInformation { BasicLimitInformation = new JobObjectBasicLimitInformation { LimitFlags = JobObjectLimitKillOnJobClose } };
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<JobObjectExtendedLimitInformation>())) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
            if (!CreateProcessW(startInfo.FileName, commandLine, IntPtr.Zero, IntPtr.Zero, false, ExtendedStartupInfoPresent | CreateUnicodeEnvironment | CreateSuspended, environmentPointer, startInfo.WorkingDirectory, ref startup, out ProcessInformation information))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
            nativeProcess = new SafeProcessHandle(information.Process, true);
            thread = information.Thread;
            int processId = checked((int)information.ProcessId);
            process = Process.GetProcessById(processId);
            if (!AssignProcessToJobObject(job, nativeProcess)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
            if (ResumeThread(thread) == uint.MaxValue) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
            CloseHandle(thread); thread = IntPtr.Zero;
            var result = new ControlledProcess(process, nativeProcess, job, processId);
            process = null; nativeProcess = null; job = null;
            return result;
        }
        finally
        {
            if (thread != IntPtr.Zero) CloseHandle(thread);
            if (nativeProcess is not null && !nativeProcess.IsInvalid) _ = TerminateProcess(nativeProcess, 0xDEAD);
            process?.Dispose(); nativeProcess?.Dispose(); job?.Dispose();
            if (attributeListInitialized) DeleteProcThreadAttributeList(attributeList);
            IntPtr heap = GetProcessHeap();
            if (policyPointer != IntPtr.Zero) _ = HeapFree(heap, 0, policyPointer);
            if (environmentPointer != IntPtr.Zero) Marshal.FreeHGlobal(environmentPointer);
            if (attributeList != IntPtr.Zero) _ = HeapFree(heap, 0, attributeList);
        }
    }

    internal static string BuildEnvironmentBlock(ProcessStartInfo startInfo)
    {
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        string system32 = Path.Combine(windows, "System32");
        startInfo.Environment["PATH"] = string.Join(';', new[] { system32, windows }.Where(Directory.Exists));
        var entries = startInfo.Environment
            .Select(static item => item.Key + "=" + (item.Value ?? string.Empty))
            .OrderBy(static value => value, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (entries.Any(static value => value.IndexOf('\0') >= 0)) throw new InvalidOperationException("Environment contains NUL");
        return string.Join('\0', entries) + "\0\0";
    }

    private static StringBuilder BuildCommandLine(ProcessStartInfo startInfo)
    {
        var result = new StringBuilder(Quote(startInfo.FileName));
        foreach (string argument in startInfo.ArgumentList) result.Append(' ').Append(Quote(argument));
        return result;
    }

    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        var slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') { result.Append('\\', slashes * 2 + 1).Append('"'); slashes = 0; continue; }
            result.Append('\\', slashes).Append(character); slashes = 0;
        }
        result.Append('\\', slashes * 2).Append('"');
        return result.ToString();
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo { public int Cb; public string? Reserved; public string? Desktop; public string? Title; public int X; public int Y; public int XSize; public int YSize; public int XCountChars; public int YCountChars; public int FillAttribute; public int Flags; public short ShowWindow; public short Reserved2; public IntPtr Reserved2Pointer; public IntPtr StdInput; public IntPtr StdOutput; public IntPtr StdError; }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr AttributeList; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInformation { public IntPtr Process; public IntPtr Thread; public uint ProcessId; public uint ThreadId; }
    [StructLayout(LayoutKind.Sequential)] private struct JobObjectBasicLimitInformation { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct JobObjectExtendedLimitInformation { public JobObjectBasicLimitInformation BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }

    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref nuint size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, nuint size, IntPtr previous, IntPtr returnedSize);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll")] private static extern IntPtr GetProcessHeap();
    [DllImport("kernel32.dll")] private static extern IntPtr HeapAlloc(IntPtr heap, uint flags, nuint bytes);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool HeapFree(IntPtr heap, uint flags, IntPtr memory);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfoEx startupInfo, out ProcessInformation processInformation);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeJobHandle CreateJobObjectW(IntPtr jobAttributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetInformationJobObject(SafeJobHandle job, int informationClass, ref JobObjectExtendedLimitInformation information, uint informationLength);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AssignProcessToJobObject(SafeJobHandle job, SafeProcessHandle process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool TerminateProcess(SafeProcessHandle process, uint exitCode);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
}
