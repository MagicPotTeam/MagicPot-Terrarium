using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace MagicPot.Launcher;

internal sealed class ArtifactPreparationException : Exception
{
    internal ArtifactPreparationException(string message) : base(message) { }
    internal ArtifactPreparationException(string message, Exception innerException) : base(message, innerException) { }
    internal ArtifactPreparationException(string message, Exception innerException, ArtifactCleanupTicket cleanupTicket) : base(message, innerException) { CleanupTicket = cleanupTicket; }
    internal ArtifactCleanupTicket? CleanupTicket { get; }
}

internal sealed class ArtifactCleanupTicket : IDisposable
{
    private readonly object gate = new();
    private PinnedStagingTree? tree;
    private long registryId;

    internal ArtifactCleanupTicket(PinnedStagingTree tree) => this.tree = tree;
    internal long GetOrCreateRegistryId()
    {
        long id = Volatile.Read(ref registryId);
        if (id != 0) return id;
        long candidate = BackgroundPreparedCleanupRegistry.NextId();
        long prior = Interlocked.CompareExchange(ref registryId, candidate, 0);
        return prior == 0 ? candidate : prior;
    }
    internal long RegistryId => Volatile.Read(ref registryId);
    internal bool CleanupCompleted { get { lock (gate) return tree is null; } }
    internal IReadOnlyList<string> Failures { get { lock (gate) return tree?.CleanupFailures ?? Array.Empty<string>(); } }
    internal bool RetryCleanup(TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        bool completed;
        lock (gate)
        {
            if (tree is null) return true;
            completed = tree.TryCleanup(timeout, cancellationToken);
            if (completed) tree = null;
        }
        if (completed) BackgroundPreparedCleanupRegistry.Remove(this);
        return completed;
    }
    public void Dispose() { if (!CleanupCompleted) BackgroundPreparedCleanupRegistry.Register(this); }
}

internal static class BackgroundPreparedCleanupRegistry
{
    private static readonly ConcurrentDictionary<long, ArtifactCleanupTicket> Pending = new();
    private static readonly Timer RetryTimer = new(static _ => RunOnePass(), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
    private static long nextId;
    private static int running;

    internal static int PendingCount => Pending.Count;
    internal static long NextId() => Interlocked.Increment(ref nextId);
    internal static void Register(ArtifactCleanupTicket ticket)
    {
        if (ticket.CleanupCompleted) return;
        Pending.TryAdd(ticket.GetOrCreateRegistryId(), ticket);
        GC.KeepAlive(RetryTimer);
    }
    internal static void Remove(ArtifactCleanupTicket ticket)
    {
        long id = ticket.RegistryId;
        if (id != 0) Pending.TryRemove(id, out _);
    }
    internal static void RunOnePass()
    {
        if (Interlocked.Exchange(ref running, 1) != 0) return;
        try
        {
            foreach (KeyValuePair<long, ArtifactCleanupTicket> item in Pending)
            {
                try { if (item.Value.RetryCleanup(TimeSpan.FromMilliseconds(100))) Pending.TryRemove(item.Key, out _); }
                catch (Exception exception) { Debug.WriteLine("Background prepared cleanup failed: " + exception); }
            }
        }
        finally { Volatile.Write(ref running, 0); }
    }
}

internal sealed class ArtifactPreparationOptions
{
    internal required string StateRoot { get; init; }
    internal int MaxEntryCount { get; init; } = 100_000;
    internal long MaxSingleUncompressedBytes { get; init; } = Protocol.MaxUnpackedSize;
    internal long MaxTotalUncompressedBytes { get; init; } = Protocol.MaxUnpackedSize;
    internal long MaxCompressionRatio { get; init; } = 1_000;
    internal Func<string>? UniqueId { get; init; }
    internal Action<string>? AfterDirectoryCreatedBeforePinned { get; init; }
    internal Action? BeforeCleanupAttempt { get; init; }
}

internal sealed class PreparedArtifactPackage : IDisposable, IAsyncDisposable
{
    private static readonly TimeSpan DefaultCleanupTimeout = TimeSpan.FromSeconds(5);
    private readonly PinnedStagingTree tree;
    private readonly PinnedStagingTree cleanupState;
    internal PreparedArtifactPackage(PinnedStagingTree tree, PinnedStagingTree cleanupState, string kind, ArtifactDownloadIdentity identity, object manifest) { this.tree = tree; this.cleanupState = cleanupState; Kind = kind; Identity = identity; Manifest = manifest; }
    internal string Root => tree.Root;
    internal string Kind { get; }
    internal ArtifactDownloadIdentity Identity { get; }
    internal object Manifest { get; }
    internal IReadOnlyList<string> Entries => tree.Entries;
    internal Stream OpenRead(string relativePath) => tree.OpenPinnedRead(relativePath);
    internal IReadOnlyList<string> CleanupFailures => cleanupState.CleanupFailures;
    internal bool CleanupCompleted => cleanupState.CleanupCompleted;
    internal bool RetryCleanup(TimeSpan timeout, CancellationToken cancellationToken = default) => cleanupState.TryCleanup(timeout, cancellationToken);
    public void Dispose() => cleanupState.TryCleanup(DefaultCleanupTimeout);
    public ValueTask DisposeAsync() => cleanupState.CleanupAsync(DefaultCleanupTimeout);
}

internal sealed class PreparedArtifactLease : IDisposable, IAsyncDisposable
{
    private const int Active = 0, Transferred = 1, CleanupOwned = 2;
    private static readonly TimeSpan DefaultCleanupTimeout = TimeSpan.FromSeconds(5);
    private readonly object ownershipGate = new();
    private PinnedStagingTree? tree;
    private PinnedStagingTree? cleanupState;
    private int disposition;
    internal PreparedArtifactLease(PinnedStagingTree tree, string kind, ArtifactDownloadIdentity identity, object manifest) { this.tree = tree; cleanupState = tree; Kind = kind; Identity = identity; Manifest = manifest; }
    internal string Root { get { lock (ownershipGate) return GetTreeLocked().Root; } }
    internal string Kind { get; }
    internal ArtifactDownloadIdentity Identity { get; }
    internal object Manifest { get; }
    internal IReadOnlyList<string> Entries { get { lock (ownershipGate) return GetTreeLocked().Entries; } }
    internal Stream OpenRead(string relativePath) { lock (ownershipGate) return GetTreeLocked().OpenPinnedRead(relativePath); }
    internal bool OwnershipTransferred { get { lock (ownershipGate) return disposition == Transferred; } }
    internal IReadOnlyList<string> CleanupFailures { get { lock (ownershipGate) return disposition == Transferred ? Array.Empty<string>() : GetCleanupStateLocked().CleanupFailures; } }
    internal bool CleanupCompleted { get { lock (ownershipGate) return disposition != Transferred && GetCleanupStateLocked().CleanupCompleted; } }
    internal bool RetryCleanup(TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        lock (ownershipGate)
        {
            ThrowIfTransferredLocked();
            disposition = CleanupOwned;
            return GetCleanupStateLocked().TryCleanup(timeout, cancellationToken);
        }
    }
    internal PreparedArtifactPackage TakeOwnership()
    {
        lock (ownershipGate)
        {
            if (disposition != Active) throw disposition == Transferred ? OwnershipTransferredError() : new InvalidOperationException("Prepared artifact cleanup has already started.");
            PinnedStagingTree capability = GetTreeLocked();
            PinnedStagingTree cleanupCapability = GetCleanupStateLocked();
            var package = new PreparedArtifactPackage(capability, cleanupCapability, Kind, Identity, Manifest);
            tree = null;
            cleanupState = null;
            disposition = Transferred;
            return package;
        }
    }
    internal PreparedArtifactPackage Commit() => TakeOwnership();
    public void Dispose()
    {
        lock (ownershipGate)
        {
            if (disposition == Transferred) return;
            if (disposition == CleanupOwned) return;
            disposition = CleanupOwned;
            GetCleanupStateLocked().TryCleanup(DefaultCleanupTimeout);
        }
    }
    public ValueTask DisposeAsync()
    {
        lock (ownershipGate)
        {
            if (disposition is Transferred or CleanupOwned) return ValueTask.CompletedTask;
            disposition = CleanupOwned;
            return GetCleanupStateLocked().CleanupAsync(DefaultCleanupTimeout);
        }
    }
    private PinnedStagingTree GetTreeLocked() { ThrowIfTransferredLocked(); return tree ?? throw new ObjectDisposedException(nameof(PreparedArtifactLease)); }
    private PinnedStagingTree GetCleanupStateLocked() => cleanupState ?? throw new ObjectDisposedException(nameof(PreparedArtifactLease));
    private void ThrowIfTransferredLocked() { if (disposition == Transferred) throw OwnershipTransferredError(); }
    private static InvalidOperationException OwnershipTransferredError() => new("Prepared artifact ownership was transferred; the old lease no longer has a capability.");
}

internal sealed class PinnedAncestorChain : IDisposable
{
    private readonly List<(string Path, SafeFileHandle Handle)> directories = [];

    internal PinnedAncestorChain(string configuredStateRoot, Action<string>? creationHook)
    {
        StateRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(configuredStateRoot));
        PreparedRoot = Path.Combine(StateRoot, "prepared");
        try { PinPath(StateRoot, creationHook); PinPath(PreparedRoot, creationHook); Validate(); }
        catch { Dispose(); throw; }
    }

    internal string StateRoot { get; }
    internal string PreparedRoot { get; }
    internal string CanonicalPreparedRoot => CanonicalPath(directories[^1].Handle);

    public void Dispose() { for (int index = directories.Count - 1; index >= 0; index--) directories[index].Handle.Dispose(); directories.Clear(); }

    internal void Validate()
    {
        foreach ((string path, SafeFileHandle handle) in directories) ValidateDirectory(handle, path);
    }

    private void PinPath(string target, Action<string>? creationHook)
    {
        string root = Path.GetPathRoot(target) ?? throw new ArtifactPreparationException("State path has no volume root.");
        string current = root;
        if (!directories.Any(item => string.Equals(item.Path, NormalizeFinalPath(current), StringComparison.OrdinalIgnoreCase))) PinExisting(current);
        foreach (string segment in target[root.Length..].Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
        {
            if (segment.Length == 0) continue;
            current = Path.Combine(current, segment);
            if (directories.Any(item => string.Equals(item.Path, current, StringComparison.OrdinalIgnoreCase))) continue;
            if (!Directory.Exists(current))
            {
                if (!CreateDirectoryW(current, IntPtr.Zero))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error != ErrorAlreadyExists) throw new ArtifactPreparationException("Pinned ancestor creation failed.", new Win32Exception(error));
                }
                else creationHook?.Invoke(current);
            }
            PinExisting(current);
        }
    }

    private void PinExisting(string path)
    {
        SafeFileHandle handle = CreateFileW(path, FileReadAttributes, FileShare.ReadWrite, IntPtr.Zero, FileMode.Open, FileFlagBackupSemantics | FileFlagOpenReparsePoint, IntPtr.Zero);
        if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new ArtifactPreparationException("Pinned ancestor open failed.", new Win32Exception(error)); }
        try { ValidateDirectory(handle, path); directories.Add((NormalizeFinalPath(path), handle)); }
        catch { handle.Dispose(); throw; }
    }

    private static void ValidateDirectory(SafeFileHandle handle, string expected)
    {
        if (!GetFileInformationByHandle(handle, out ByHandleFileInformation info)) throw new ArtifactPreparationException("Pinned ancestor identity read failed.", new Win32Exception(Marshal.GetLastWin32Error()));
        FileAttributes attributes = (FileAttributes)info.FileAttributes;
        if ((attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0 || info.NumberOfLinks != 1) throw new ArtifactPreparationException("Pinned ancestor is not a regular single-link directory.");
        if (!string.Equals(CanonicalPath(handle), NormalizeFinalPath(expected), StringComparison.OrdinalIgnoreCase)) throw new ArtifactPreparationException("Pinned ancestor canonical path escaped or changed.");
    }

    private static string CanonicalPath(SafeFileHandle handle) { var buffer = new StringBuilder(512); uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0); if (length == 0) throw new ArtifactPreparationException("Pinned ancestor canonical path query failed.", new Win32Exception(Marshal.GetLastWin32Error())); if (length >= buffer.Capacity) { buffer.EnsureCapacity(checked((int)length + 1)); length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0); if (length == 0 || length >= buffer.Capacity) throw new ArtifactPreparationException("Pinned ancestor canonical path query failed.", new Win32Exception(Marshal.GetLastWin32Error())); } return NormalizeFinalPath(buffer.ToString()); }
    private static string NormalizeFinalPath(string value) { if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) value = @"\\" + value[8..]; else if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) value = value[4..]; string full = Path.GetFullPath(value); string root = Path.GetPathRoot(full) ?? full; return string.Equals(full, root, StringComparison.OrdinalIgnoreCase) ? root : Path.TrimEndingDirectorySeparator(full); }

    private const int ErrorAlreadyExists = 183;
    private const uint FileReadAttributes = 0x00000080, FileFlagBackupSemantics = 0x02000000, FileFlagOpenReparsePoint = 0x00200000;
    [StructLayout(LayoutKind.Sequential)] private struct ByHandleFileInformation { internal uint FileAttributes; internal System.Runtime.InteropServices.ComTypes.FILETIME CreationTime; internal System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime; internal System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime; internal uint VolumeSerialNumber; internal uint FileSizeHigh; internal uint FileSizeLow; internal uint NumberOfLinks; internal uint FileIndexHigh; internal uint FileIndexLow; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)] private static extern SafeFileHandle CreateFileW(string fileName, uint desiredAccess, FileShare shareMode, IntPtr securityAttributes, FileMode creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateDirectoryW(string pathName, IntPtr securityAttributes);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out ByHandleFileInformation fileInformation);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint pathLength, uint flags);
}

internal sealed class PinnedStagingTree : IDisposable
{
    private const int MaxCleanupFailures = 128;
    private readonly object sync = new();
    private readonly object cleanupGate = new();
    private readonly Dictionary<string, SafeFileHandle> directories = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, FileStream> files = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<string> cleanupFailures = [];
    private readonly Action<string>? afterDirectoryCreatedBeforePinned;
    private readonly Action? beforeCleanupAttempt;
    private readonly string canonicalRoot;
    private readonly PinnedAncestorChain ancestorChain;
    private int activeReaders;
    private bool closing;
    private bool cleanupCompleted;

    private PinnedStagingTree(string root, SafeFileHandle rootHandle, Action<string>? hook, Action? cleanupHook, PinnedAncestorChain ancestors)
    {
        Root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        canonicalRoot = CanonicalPath(rootHandle);
        afterDirectoryCreatedBeforePinned = hook;
        beforeCleanupAttempt = cleanupHook;
        ancestorChain = ancestors;
        directories.Add(string.Empty, rootHandle);
    }

    internal string Root { get; }
    internal IReadOnlyList<string> Entries { get { lock (sync) return files.Keys.OrderBy(static value => value, StringComparer.OrdinalIgnoreCase).ToArray(); } }
    internal IReadOnlyList<string> CleanupFailures { get { lock (sync) return cleanupFailures.ToArray(); } }
    internal bool CleanupCompleted { get { lock (sync) return cleanupCompleted; } }

    internal static PinnedStagingTree PinCreatedRoot(string root, PinnedAncestorChain ancestors, Action<string>? hook = null, Action? cleanupHook = null)
    {
        ancestors.Validate();
        SafeFileHandle handle = OpenDirectoryHandle(root);
        try
        {
            ValidateDirectory(handle, CanonicalPath(handle));
            string expectedParent = ancestors.CanonicalPreparedRoot + Path.DirectorySeparatorChar;
            if (!CanonicalPath(handle).StartsWith(expectedParent, StringComparison.OrdinalIgnoreCase)) throw new ArtifactPreparationException("Prepared root is outside pinned prepared parent.");
            ancestors.Validate();
            return new PinnedStagingTree(root, handle, hook, cleanupHook, ancestors);
        }
        catch { handle.Dispose(); throw; }
    }

    internal void ValidateRoot() { ThrowIfDisposed(); ancestorChain.Validate(); ValidateDirectory(directories[string.Empty], canonicalRoot); }

    internal void EnsureDirectories(IReadOnlyList<string> segments)
    {
        ThrowIfDisposed(); string relative = string.Empty;
        foreach (string segment in segments)
        {
            string parent = relative; relative = relative.Length == 0 ? segment : parent + "/" + segment;
            if (directories.ContainsKey(relative)) { ValidateDirectory(directories[parent], ExpectedDirectoryPath(parent)); ValidateDirectory(directories[relative], ExpectedDirectoryPath(relative)); continue; }
            ValidateDirectory(directories[parent], ExpectedDirectoryPath(parent));
            string path = PhysicalPath(relative);
            if (!CreateDirectoryW(path, IntPtr.Zero))
            {
                int error = Marshal.GetLastWin32Error();
                if (error != ErrorAlreadyExists) throw new ArtifactPreparationException("Prepared directory create failed.", new Win32Exception(error));
            }
            else afterDirectoryCreatedBeforePinned?.Invoke(path);
            SafeFileHandle handle = OpenDirectoryHandle(path);
            try { ValidateDirectory(handle, ExpectedDirectoryPath(relative)); directories.Add(relative, handle); }
            catch { handle.Dispose(); throw; }
        }
    }

    internal FileStream OpenNewFile(string relativePath)
    {
        ThrowIfDisposed(); relativePath = NormalizeRelative(relativePath); string parent = Parent(relativePath); ValidateDirectory(directories[parent], ExpectedDirectoryPath(parent));
        string path = PhysicalPath(relativePath);
        SafeFileHandle handle = CreateFileW(path, GenericRead | GenericWrite | DeleteAccess, FileShare.None, IntPtr.Zero, FileMode.CreateNew, FileAttributeNormal | FileFlagOpenReparsePoint | FileFlagWriteThrough, IntPtr.Zero);
        if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new ArtifactPreparationException("Safe prepared file create failed.", new Win32Exception(error)); }
        try
        {
            ValidateFile(handle, ExpectedFilePath(relativePath));
            var stream = new FileStream(handle, FileAccess.ReadWrite, 131_072, false);
            files.Add(relativePath, stream);
            return stream;
        }
        catch { handle.Dispose(); throw; }
    }

    internal Stream OpenPinnedRead(string relativePath)
    {
        relativePath = NormalizeRelative(relativePath);
        lock (sync)
        {
            if (closing) throw new ObjectDisposedException(nameof(PinnedStagingTree), "Prepared artifact cleanup has started.");
            if (!files.TryGetValue(relativePath, out FileStream? pinned)) throw new ArtifactPreparationException("Prepared file is not part of the pinned capability: " + relativePath);
            ValidateFile(pinned.SafeFileHandle, ExpectedFilePath(relativePath));
            if (!DuplicateHandle(GetCurrentProcess(), pinned.SafeFileHandle, GetCurrentProcess(), out SafeFileHandle duplicate, GenericRead, false, 0)) throw new ArtifactPreparationException("Pinned file handle duplication failed.", new Win32Exception(Marshal.GetLastWin32Error()));
            try
            {
                var stream = new FileStream(duplicate, FileAccess.Read, 131_072, false);
                stream.Seek(0, SeekOrigin.Begin);
                activeReaders++;
                return new TrackingReadStream(stream, ReaderClosed);
            }
            catch { duplicate.Dispose(); throw; }
        }
    }

    internal void ValidatePinnedFile(string relativePath) { relativePath = NormalizeRelative(relativePath); ValidateFile(files[relativePath].SafeFileHandle, ExpectedFilePath(relativePath)); }
    internal void ValidateAll() { ValidateRoot(); foreach (var item in directories) ValidateDirectory(item.Value, ExpectedDirectoryPath(item.Key)); foreach (var item in files) ValidateFile(item.Value.SafeFileHandle, ExpectedFilePath(item.Key)); }

    public void Dispose() => TryCleanup(TimeSpan.FromSeconds(5));

    internal ValueTask CleanupAsync(TimeSpan timeout, CancellationToken cancellationToken = default) => new(Task.Run(() => TryCleanup(timeout, cancellationToken), cancellationToken));

    internal bool TryCleanup(TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        if (timeout < TimeSpan.Zero && timeout != Timeout.InfiniteTimeSpan) throw new ArgumentOutOfRangeException(nameof(timeout));
        lock (cleanupGate)
        {
            beforeCleanupAttempt?.Invoke();
            Stopwatch stopwatch = Stopwatch.StartNew();
            lock (sync)
            {
                if (cleanupCompleted) return true;
                closing = true;
                while (activeReaders != 0)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    TimeSpan remaining = timeout == Timeout.InfiniteTimeSpan ? Timeout.InfiniteTimeSpan : timeout - stopwatch.Elapsed;
                    if (remaining <= TimeSpan.Zero) { AddCleanupFailureLocked("active readers prevented cleanup before timeout"); return false; }
                    TimeSpan wait = remaining == Timeout.InfiniteTimeSpan || remaining > TimeSpan.FromMilliseconds(100) ? TimeSpan.FromMilliseconds(100) : remaining;
                    Monitor.Wait(sync, wait);
                }
            }

            foreach (string key in SnapshotFileKeys())
            {
                FileStream? stream;
                lock (sync) { if (!files.TryGetValue(key, out stream)) continue; }
                if (!TryDeleteByHandle(stream.SafeFileHandle, key)) continue;
                stream.Dispose();
                lock (sync) files.Remove(key);
            }
            foreach (string key in SnapshotDirectoryKeys())
            {
                SafeFileHandle? handle;
                lock (sync) { if (!directories.TryGetValue(key, out handle)) continue; }
                if (!TryDeleteByHandle(handle, key.Length == 0 ? "<root>" : key)) continue;
                handle.Dispose();
                lock (sync) directories.Remove(key);
            }

            lock (sync)
            {
                cleanupCompleted = files.Count == 0 && directories.Count == 0;
                if (cleanupCompleted) ancestorChain.Dispose();
                return cleanupCompleted;
            }
        }
    }

    private string[] SnapshotFileKeys() { lock (sync) return files.Keys.OrderByDescending(static key => key.Count(static c => c == '/')).ToArray(); }
    private string[] SnapshotDirectoryKeys() { lock (sync) return directories.Keys.OrderByDescending(static key => key.Length == 0 ? -1 : key.Count(static c => c == '/') + 1).ThenByDescending(static key => key.Length).ToArray(); }

    private bool TryDeleteByHandle(SafeFileHandle handle, string name)
    {
        var disposition = new FileDispositionInformation { DeleteFile = true };
        if (SetFileInformationByHandle(handle, FileInfoByHandleClass.FileDispositionInfo, ref disposition, (uint)Marshal.SizeOf<FileDispositionInformation>())) return true;
        lock (sync) AddCleanupFailureLocked(name + ": " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
        return false;
    }

    private void AddCleanupFailureLocked(string message)
    {
        if (cleanupFailures.Count == 0 || !string.Equals(cleanupFailures[^1], message, StringComparison.Ordinal))
        {
            cleanupFailures.Add(message);
            if (cleanupFailures.Count > MaxCleanupFailures) cleanupFailures.RemoveAt(0);
        }
        Debug.WriteLine("Pinned staging cleanup failed: " + message);
    }

    private void ReaderClosed()
    {
        lock (sync)
        {
            if (activeReaders <= 0) return;
            activeReaders--;
            if (activeReaders == 0) Monitor.PulseAll(sync);
        }
    }

    private string PhysicalPath(string relative) => relative.Length == 0 ? Root : Path.Combine(Root, relative.Replace('/', Path.DirectorySeparatorChar));
    private string ExpectedDirectoryPath(string relative) => relative.Length == 0 ? canonicalRoot : canonicalRoot + Path.DirectorySeparatorChar + relative.Replace('/', Path.DirectorySeparatorChar);
    private string ExpectedFilePath(string relative) => canonicalRoot + Path.DirectorySeparatorChar + relative.Replace('/', Path.DirectorySeparatorChar);
    private static string Parent(string relative) { int index = relative.LastIndexOf('/'); return index < 0 ? string.Empty : relative[..index]; }
    private static string NormalizeRelative(string relative) { if (string.IsNullOrEmpty(relative) || relative.Contains('\\') || Path.IsPathFullyQualified(relative) || relative.Split('/').Any(static value => value is "" or "." or "..")) throw new ArtifactPreparationException("Pinned relative path is unsafe."); return relative; }
    private void ThrowIfDisposed() { lock (sync) if (closing) throw new ObjectDisposedException(nameof(PinnedStagingTree)); }

    private static SafeFileHandle OpenDirectoryHandle(string path)
    {
        SafeFileHandle handle = CreateFileW(path, FileReadAttributes | DeleteAccess, FileShare.None, IntPtr.Zero, FileMode.Open, FileFlagBackupSemantics | FileFlagOpenReparsePoint, IntPtr.Zero);
        if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new ArtifactPreparationException("Pinned directory open failed.", new Win32Exception(error)); }
        return handle;
    }

    private static void ValidateDirectory(SafeFileHandle handle, string expected)
    {
        ByHandleFileInformation info = Information(handle, "directory"); FileAttributes attributes = (FileAttributes)info.FileAttributes;
        if ((attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0 || info.NumberOfLinks != 1) throw new ArtifactPreparationException("Pinned directory is not regular single-link.");
        RequireCanonical(handle, expected);
    }

    private static void ValidateFile(SafeFileHandle handle, string expected)
    {
        ByHandleFileInformation info = Information(handle, "file"); FileAttributes attributes = (FileAttributes)info.FileAttributes;
        if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 || info.NumberOfLinks != 1) throw new ArtifactPreparationException("Prepared file is not regular single-link.");
        RequireCanonical(handle, expected);
    }

    private static ByHandleFileInformation Information(SafeFileHandle handle, string kind) { if (!GetFileInformationByHandle(handle, out ByHandleFileInformation info)) throw new ArtifactPreparationException("Pinned " + kind + " identity read failed.", new Win32Exception(Marshal.GetLastWin32Error())); return info; }
    private static void RequireCanonical(SafeFileHandle handle, string expected) { string actual = CanonicalPath(handle); if (!string.Equals(actual, NormalizeFinalPath(expected), StringComparison.OrdinalIgnoreCase)) throw new ArtifactPreparationException("Pinned object canonical path escaped or changed."); }
    private static string CanonicalPath(SafeFileHandle handle) { var buffer = new StringBuilder(512); uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0); if (length == 0) throw new ArtifactPreparationException("Canonical path query failed.", new Win32Exception(Marshal.GetLastWin32Error())); if (length >= buffer.Capacity) { buffer.EnsureCapacity(checked((int)length + 1)); length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0); if (length == 0 || length >= buffer.Capacity) throw new ArtifactPreparationException("Canonical path query failed.", new Win32Exception(Marshal.GetLastWin32Error())); } return NormalizeFinalPath(buffer.ToString()); }
    private static string NormalizeFinalPath(string value) { if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) value = @"\\" + value[8..]; else if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) value = value[4..]; string full = Path.GetFullPath(value); string root = Path.GetPathRoot(full) ?? full; return string.Equals(full, root, StringComparison.OrdinalIgnoreCase) ? root : Path.TrimEndingDirectorySeparator(full); }

    private sealed class TrackingReadStream(Stream inner, Action closed) : Stream
    {
        private int disposed;
        public override bool CanRead => inner.CanRead;
        public override bool CanSeek => inner.CanSeek;
        public override bool CanWrite => false;
        public override long Length => inner.Length;
        public override long Position { get => inner.Position; set => inner.Position = value; }
        public override void Flush() => inner.Flush();
        public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, count);
        public override int Read(Span<byte> buffer) => inner.Read(buffer);
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => inner.ReadAsync(buffer, cancellationToken);
        public override long Seek(long offset, SeekOrigin origin) => inner.Seek(offset, origin);
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { if (Interlocked.Exchange(ref disposed, 1) != 0) return; try { if (disposing) inner.Dispose(); } finally { closed(); } base.Dispose(disposing); }
        public override async ValueTask DisposeAsync() { if (Interlocked.Exchange(ref disposed, 1) != 0) return; try { await inner.DisposeAsync().ConfigureAwait(false); } finally { closed(); GC.SuppressFinalize(this); } }
    }

    private const int ErrorAlreadyExists = 183;
    private const uint GenericRead = 0x80000000, GenericWrite = 0x40000000, DeleteAccess = 0x00010000, FileReadAttributes = 0x00000080;
    private const uint FileAttributeNormal = 0x00000080, FileFlagWriteThrough = 0x80000000, FileFlagBackupSemantics = 0x02000000, FileFlagOpenReparsePoint = 0x00200000;
    private enum FileInfoByHandleClass { FileDispositionInfo = 4 }
    [StructLayout(LayoutKind.Sequential)] private struct FileDispositionInformation { [MarshalAs(UnmanagedType.Bool)] internal bool DeleteFile; }
    [StructLayout(LayoutKind.Sequential)] private struct ByHandleFileInformation { internal uint FileAttributes; internal System.Runtime.InteropServices.ComTypes.FILETIME CreationTime; internal System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime; internal System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime; internal uint VolumeSerialNumber; internal uint FileSizeHigh; internal uint FileSizeLow; internal uint NumberOfLinks; internal uint FileIndexHigh; internal uint FileIndexLow; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)] private static extern SafeFileHandle CreateFileW(string fileName, uint desiredAccess, FileShare shareMode, IntPtr securityAttributes, FileMode creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateDirectoryW(string pathName, IntPtr securityAttributes);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out ByHandleFileInformation fileInformation);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint pathLength, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetFileInformationByHandle(SafeFileHandle file, FileInfoByHandleClass informationClass, ref FileDispositionInformation information, uint bufferSize);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool DuplicateHandle(IntPtr sourceProcess, SafeFileHandle source, IntPtr targetProcess, out SafeFileHandle target, uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
}

internal sealed class ArtifactPreparer
{
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly HashSet<string> DeviceNames = new(StringComparer.OrdinalIgnoreCase) { "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9" };
    private readonly string configuredStateRoot;
    private readonly int maxEntryCount;
    private readonly long maxSingleBytes;
    private readonly long maxTotalBytes;
    private readonly long maxCompressionRatio;
    private readonly Func<string> uniqueId;
    private readonly Action<string>? afterDirectoryCreatedBeforePinned;
    private readonly Action? beforeCleanupAttempt;

    internal ArtifactPreparer(ArtifactPreparationOptions options)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("ArtifactPreparer is Windows-only.");
        ArgumentNullException.ThrowIfNull(options); ArgumentException.ThrowIfNullOrWhiteSpace(options.StateRoot);
        if (!Path.IsPathFullyQualified(options.StateRoot)) throw new ArgumentException("StateRoot must be absolute.", nameof(options));
        if (options.MaxEntryCount <= 0 || options.MaxSingleUncompressedBytes <= 0 || options.MaxTotalUncompressedBytes <= 0 || options.MaxCompressionRatio <= 0) throw new ArgumentOutOfRangeException(nameof(options));
        configuredStateRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(options.StateRoot));
        maxEntryCount = options.MaxEntryCount; maxSingleBytes = options.MaxSingleUncompressedBytes; maxTotalBytes = options.MaxTotalUncompressedBytes; maxCompressionRatio = options.MaxCompressionRatio; uniqueId = options.UniqueId ?? (static () => Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture)); afterDirectoryCreatedBeforePinned = options.AfterDirectoryCreatedBeforePinned; beforeCleanupAttempt = options.BeforeCleanupAttempt;
    }

    internal async Task<PreparedArtifactLease> PrepareAsync(VerifiedArtifactLease lease, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(lease); ValidateFormat(lease.Identity.Url);
        var ancestors = new PinnedAncestorChain(configuredStateRoot, afterDirectoryCreatedBeforePinned);
        PinnedStagingTree? tree = null; string? partialRoot = null; bool rootCreated = false; bool chainTransferred = false;
        try
        {
            Stream source = lease.Stream;
            if (!source.CanRead || !source.CanSeek) throw new ArtifactPreparationException("Verified artifact stream must be readable and seekable.");
            source.Seek(0, SeekOrigin.Begin);
            string cacheKey = Convert.ToHexString(SHA256.HashData(StrictUtf8.GetBytes(lease.Identity.ManifestRawDigest + "\n" + lease.Sha256))).ToLowerInvariant();
            string preparedRoot = ancestors.PreparedRoot;
            string partialName = cacheKey + ".partial-" + SafeUniqueId();
            const int maxPartialNameLength = 96;
            if (partialName.Length > maxPartialNameLength) partialName = partialName[..maxPartialNameLength];
            partialRoot = Path.Combine(preparedRoot, partialName);
            if (!string.Equals(Path.GetDirectoryName(partialRoot), preparedRoot, StringComparison.OrdinalIgnoreCase)) throw new ArtifactPreparationException("Prepared path escaped pinned prepared root.");
            ancestors.Validate(); CreatePreparedDirectory(partialRoot); rootCreated = true; afterDirectoryCreatedBeforePinned?.Invoke(partialRoot); ancestors.Validate();
            tree = PinnedStagingTree.PinCreatedRoot(partialRoot, ancestors, afterDirectoryCreatedBeforePinned, beforeCleanupAttempt); chainTransferred = true;
            object manifest = await ExtractAndValidateAsync(source, lease.Identity, tree, cancellationToken).ConfigureAwait(false);
            tree.ValidateRoot(); PreparedArtifactLease result = new(tree, lease.Kind, lease.Identity, manifest); tree = null; rootCreated = false; return result;
        }
        catch (Exception exception)
        {
            if (tree is not null)
            {
                bool cleaned = false;
                try { cleaned = tree.TryCleanup(TimeSpan.FromMilliseconds(100)); }
                catch (Exception cleanupError) { Debug.WriteLine("Immediate failed-preparation cleanup failed: " + cleanupError); }
                if (!cleaned)
                {
                    var ticket = new ArtifactCleanupTicket(tree);
                    tree = null;
                    BackgroundPreparedCleanupRegistry.Register(ticket);
                    if (exception is ArtifactPreparationException preparationException) throw new ArtifactPreparationException(preparationException.Message, preparationException.InnerException ?? preparationException, ticket);
                    throw new ArtifactPreparationException(exception is OperationCanceledException ? exception.Message : "Artifact preparation failed closed.", exception, ticket);
                }
                tree = null;
            }
            if (exception is ArtifactPreparationException or OperationCanceledException) throw;
            throw new ArtifactPreparationException("Artifact preparation failed closed.", exception);
        }
        finally
        {
            if (!chainTransferred)
            {
                if (rootCreated && partialRoot is not null) TryDeleteUnpinnedEmptyRoot(partialRoot);
                ancestors.Dispose();
            }
        }
    }

    private async Task<object> ExtractAndValidateAsync(Stream source, ArtifactDownloadIdentity identity, PinnedStagingTree tree, CancellationToken cancellationToken)
    {
        IReadOnlyList<CentralEntry> centralEntries = ReadCentralDirectory(source);
        source.Seek(0, SeekOrigin.Begin);
        using var archive = new ZipArchive(source, ZipArchiveMode.Read, true, StrictUtf8);
        if (archive.Entries.Count > maxEntryCount || archive.Entries.Count != centralEntries.Count) throw new ArtifactPreparationException("ZIP entry count exceeds limit or central directory is inconsistent.");
        var entries = new List<ValidatedEntry>(archive.Entries.Count); var paths = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase); long declaredTotal = 0; long compressedTotal = 0;
        for (int entryIndex = 0; entryIndex < archive.Entries.Count; entryIndex++)
        {
            ZipArchiveEntry entry = archive.Entries[entryIndex]; CentralEntry central = centralEntries[entryIndex];
            ValidateZipHeaders(central);
            if (!string.Equals(entry.FullName, central.Name, StringComparison.Ordinal)) throw new ArtifactPreparationException("ZIP entry order or name differs from the central directory.");
            bool directory = ValidateEntryName(entry.FullName, out string relativePath); ValidateExternalAttributes(entry, directory);
            if (entry.Length != central.UncompressedSize || entry.CompressedLength != central.CompressedSize) throw new ArtifactPreparationException("ZIP library sizes differ from the central directory.");
            if (directory && (central.Crc32 != 0 || central.CompressedSize != 0 || central.UncompressedSize != 0)) throw new ArtifactPreparationException("ZIP directory entries must have zero CRC and sizes.");
            if (!paths.TryAdd(relativePath, directory)) throw new ArtifactPreparationException("ZIP contains a duplicate case-insensitive path."); ValidatePrefixConflicts(paths, relativePath, directory);
            if (entry.Length < 0 || entry.CompressedLength < 0 || entry.Length > identity.UnpackedSize || entry.Length > maxSingleBytes) throw new ArtifactPreparationException("ZIP entry exceeds size limit.");
            declaredTotal = checked(declaredTotal + entry.Length); compressedTotal = checked(compressedTotal + entry.CompressedLength);
            if (declaredTotal > identity.UnpackedSize || declaredTotal > maxTotalBytes) throw new ArtifactPreparationException("ZIP total exceeds signed/configured limit."); entries.Add(new(entry, central, relativePath, directory));
        }
        if (declaredTotal != identity.UnpackedSize) throw new ArtifactPreparationException("ZIP total uncompressed size must exactly match signed unpackedSize, including manifest.json.");
        if (declaredTotal > 0 && (compressedTotal == 0 || declaredTotal > checked(compressedTotal * maxCompressionRatio))) throw new ArtifactPreparationException("ZIP compression ratio exceeds budget.");
        long writtenTotal = 0;
        foreach (ValidatedEntry item in entries)
        {
            cancellationToken.ThrowIfCancellationRequested(); tree.ValidateRoot();
            if (item.IsDirectory) { tree.EnsureDirectories(item.RelativePath.Split('/')); continue; }
            string[] segments = item.RelativePath.Split('/'); tree.EnsureDirectories(segments[..^1]);
            FileStream output = tree.OpenNewFile(item.RelativePath); using Stream input = OpenEntryFailClosed(item.Entry); byte[] buffer = new byte[131_072]; long fileWritten = 0; uint crc = 0xffffffff;
            try
            {
                while (true) { int count = await input.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false); if (count == 0) break; fileWritten = checked(fileWritten + count); writtenTotal = checked(writtenTotal + count); if (fileWritten > item.Central.UncompressedSize || fileWritten > maxSingleBytes || writtenTotal > identity.UnpackedSize || writtenTotal > maxTotalBytes) throw new ArtifactPreparationException("ZIP expanded beyond limits."); crc = UpdateCrc32(crc, buffer.AsSpan(0, count)); await output.WriteAsync(buffer.AsMemory(0, count), cancellationToken).ConfigureAwait(false); }
            }
            catch (Exception exception) when (exception is InvalidDataException or IOException or NotSupportedException) { throw new ArtifactPreparationException("ZIP entry is encrypted, unsupported, or corrupt.", exception); }
            if (fileWritten != item.Central.UncompressedSize) throw new ArtifactPreparationException("ZIP entry length changed while reading.");
            if ((crc ^ 0xffffffff) != item.Central.Crc32) throw new ArtifactPreparationException("ZIP entry CRC32 mismatch: " + item.Central.Name);
            await output.FlushAsync(cancellationToken).ConfigureAwait(false); output.Flush(true); output.Seek(0, SeekOrigin.Begin); tree.ValidatePinnedFile(item.RelativePath);
        }
        if (writtenTotal != identity.UnpackedSize) throw new ArtifactPreparationException("Extracted byte total differs from signed unpackedSize.");
        using Stream manifestStream = tree.OpenPinnedRead("manifest.json"); long manifestLength = manifestStream.Length; string manifestText = await ReadTextBoundedAsync(manifestStream, identity.UnpackedSize, cancellationToken).ConfigureAwait(false);
        object manifest = ValidateManifest(identity, manifestText, manifestLength); await ValidateOutputAsync(tree, manifest, cancellationToken).ConfigureAwait(false); return manifest;
    }

    private static object ValidateManifest(ArtifactDownloadIdentity identity, string text, long manifestLength)
    {
        if (identity.Kind == "app") { InstalledAppManifestV1 manifest = Protocol.ParseAppManifest(text); if (manifest.Version != identity.Version || manifest.BuildId != identity.BuildId || manifest.CommitSha != identity.CommitSha || manifest.RuntimeId != identity.RuntimeId || !SamePath(manifest.Entrypoint, identity.Entrypoint) || checked(manifest.UnpackedSize + manifestLength) != identity.UnpackedSize) throw new ArtifactPreparationException("App manifest identity or unpacked size mismatch."); return manifest; }
        if (identity.Kind == "runtime") { InstalledRuntimeManifestV1 manifest = Protocol.ParseRuntimeManifest(text); if (manifest.RuntimeId != identity.RuntimeId || !SamePath(manifest.Entrypoints.Python, identity.Entrypoint) || checked(manifest.UnpackedSize + manifestLength) != identity.UnpackedSize) throw new ArtifactPreparationException("Runtime manifest identity or unpacked size mismatch."); return manifest; }
        throw new ArtifactPreparationException("Unsupported artifact kind.");
    }

    private static async Task ValidateOutputAsync(PinnedStagingTree tree, object manifest, CancellationToken cancellationToken)
    {
        IReadOnlyList<InstalledFileV1>? files; string[] entrypoints;
        if (manifest is InstalledAppManifestV1 app) { files = app.Files; entrypoints = [app.Entrypoint]; } else { var runtime = (InstalledRuntimeManifestV1)manifest; files = runtime.Files; entrypoints = [runtime.Entrypoints.Python, runtime.Entrypoints.Comfyui]; }
        foreach (string entrypoint in entrypoints) using (tree.OpenPinnedRead(NormalizeManifestPath(entrypoint))) { }
        if (files is not null) foreach (InstalledFileV1 file in files) { using Stream stream = tree.OpenPinnedRead(NormalizeManifestPath(file.Path)); if (stream.Length != file.Size) throw new ArtifactPreparationException("Manifest file size mismatch: " + file.Path); byte[] digest = await SHA256.HashDataAsync(stream, cancellationToken).ConfigureAwait(false); if (!CryptographicOperations.FixedTimeEquals(digest, Convert.FromHexString(file.Sha256))) throw new ArtifactPreparationException("Manifest file hash mismatch: " + file.Path); }
        tree.ValidateAll();
    }

    private static Stream OpenEntryFailClosed(ZipArchiveEntry entry) { try { return entry.Open(); } catch (Exception exception) when (exception is InvalidDataException or IOException or NotSupportedException) { throw new ArtifactPreparationException("ZIP entry is encrypted, unsupported, or corrupt.", exception); } }

    private static IReadOnlyList<CentralEntry> ReadCentralDirectory(Stream source)
    {
        long saved = source.Position;
        try
        {
            if (source.Length < 22) throw new ArtifactPreparationException("ZIP end record is missing.");
            int tailLength = checked((int)Math.Min(source.Length, 65_557)); byte[] tail = new byte[tailLength]; source.Seek(-tailLength, SeekOrigin.End); source.ReadExactly(tail);
            int end = -1;
            for (int i = tail.Length - 22; i >= 0; i--)
            {
                if (ReadUInt32(tail, i) == 0x06054b50 && i + 22 + ReadUInt16(tail, i + 20) == tail.Length) { end = i; break; }
            }
            if (end < 0) throw new ArtifactPreparationException("ZIP end record is missing or has an invalid comment length.");
            long endOffset = checked(source.Length - tailLength + end);
            ushort disk = ReadUInt16(tail, end + 4); ushort directoryDisk = ReadUInt16(tail, end + 6); ushort diskCount = ReadUInt16(tail, end + 8); ushort totalCount = ReadUInt16(tail, end + 10); uint directorySize = ReadUInt32(tail, end + 12); uint directoryOffset = ReadUInt32(tail, end + 16);
            if (disk == ushort.MaxValue || directoryDisk == ushort.MaxValue || diskCount == ushort.MaxValue || totalCount == ushort.MaxValue || directoryOffset == uint.MaxValue || directorySize == uint.MaxValue) throw new ArtifactPreparationException("ZIP64 sentinel values are not supported.");
            if (disk != 0 || directoryDisk != 0 || diskCount != totalCount) throw new ArtifactPreparationException("Multi-disk ZIP archives are not supported.");
            long directoryEnd = checked((long)directoryOffset + directorySize);
            if (directoryEnd > endOffset) throw new ArtifactPreparationException("ZIP central directory extends into the end record.");
            source.Seek(directoryOffset, SeekOrigin.Begin); var result = new List<CentralEntry>(totalCount);
            for (int index = 0; index < totalCount; index++)
            {
                if (source.Position > directoryEnd - 46) throw new ArtifactPreparationException("ZIP central directory entry exceeds its declared size.");
                byte[] header = new byte[46]; source.ReadExactly(header); if (ReadUInt32(header, 0) != 0x02014b50) throw new ArtifactPreparationException("ZIP central directory is corrupt.");
                ushort flags = ReadUInt16(header, 8); ushort method = ReadUInt16(header, 10); uint crc32 = ReadUInt32(header, 16); uint compressedSize = ReadUInt32(header, 20); uint uncompressedSize = ReadUInt32(header, 24); ushort nameLength = ReadUInt16(header, 28); ushort extraLength = ReadUInt16(header, 30); ushort commentLength = ReadUInt16(header, 32); ushort startDisk = ReadUInt16(header, 34); uint localOffset = ReadUInt32(header, 42);
                if (compressedSize == uint.MaxValue || uncompressedSize == uint.MaxValue || localOffset == uint.MaxValue || startDisk == ushort.MaxValue) throw new ArtifactPreparationException("ZIP64 central directory values are not supported.");
                if (startDisk != 0) throw new ArtifactPreparationException("Multi-disk ZIP entries are not supported.");
                long variableLength = checked((long)nameLength + extraLength + commentLength); if (source.Position + variableLength > directoryEnd) throw new ArtifactPreparationException("ZIP central directory name, extra field, or comment exceeds its declared bounds.");
                byte[] nameBytes = new byte[nameLength]; source.ReadExactly(nameBytes); string name = (flags & 0x0800) != 0 ? StrictUtf8.GetString(nameBytes) : DecodeAsciiName(nameBytes); source.Seek(extraLength + commentLength, SeekOrigin.Current); long nextCentral = source.Position;
                LocalEntry local = ReadLocalEntry(source, localOffset, nameBytes, compressedSize, directoryOffset);
                source.Seek(nextCentral, SeekOrigin.Begin); result.Add(new CentralEntry(name, flags, method, crc32, compressedSize, uncompressedSize, localOffset, local.Flags, local.Method, local.Crc32, local.CompressedSize, local.UncompressedSize));
            }
            if (result.Count != totalCount || source.Position != directoryEnd) throw new ArtifactPreparationException("ZIP central directory size or entry count is inconsistent with EOCD.");
            return result;
        }
        catch (DecoderFallbackException exception) { throw new ArtifactPreparationException("ZIP entry name encoding is invalid.", exception); }
        finally { source.Seek(saved, SeekOrigin.Begin); }
    }

    private static LocalEntry ReadLocalEntry(Stream source, uint offset, byte[] centralName, uint centralCompressedSize, uint centralOffset)
    {
        if (offset > centralOffset || (long)offset + 30 > centralOffset) throw new ArtifactPreparationException("ZIP local header offset is outside the local-file area.");
        source.Seek(offset, SeekOrigin.Begin); byte[] header = new byte[30]; source.ReadExactly(header); if (ReadUInt32(header, 0) != 0x04034b50) throw new ArtifactPreparationException("ZIP local header is corrupt.");
        ushort flags = ReadUInt16(header, 6); ushort method = ReadUInt16(header, 8); uint crc32 = ReadUInt32(header, 14); uint compressedSize = ReadUInt32(header, 18); uint uncompressedSize = ReadUInt32(header, 22); ushort nameLength = ReadUInt16(header, 26); ushort extraLength = ReadUInt16(header, 28);
        if (compressedSize == uint.MaxValue || uncompressedSize == uint.MaxValue) throw new ArtifactPreparationException("ZIP64 local header values are not supported.");
        long dataOffset = checked(source.Position + (long)nameLength + extraLength); if (dataOffset > centralOffset || dataOffset + centralCompressedSize > centralOffset) throw new ArtifactPreparationException("ZIP local name, extra field, or compressed data exceeds the local-file area.");
        byte[] localName = new byte[nameLength]; source.ReadExactly(localName); if (!localName.AsSpan().SequenceEqual(centralName)) throw new ArtifactPreparationException("ZIP local/central names are inconsistent.");
        return new LocalEntry(flags, method, crc32, compressedSize, uncompressedSize);
    }

    private static void ValidateZipHeaders(CentralEntry entry)
    {
        const ushort allowedFlags = 0x080e;
        if ((entry.Flags & ~allowedFlags) != 0 || (entry.Method == 0 && (entry.Flags & 0x0006) != 0)) throw new ArtifactPreparationException("ZIP entry uses encryption or unsupported general-purpose flags.");
        if (entry.Method is not (0 or 8)) throw new ArtifactPreparationException("ZIP compression method is unsupported.");
        if (entry.LocalFlags != entry.Flags || entry.LocalMethod != entry.Method) throw new ArtifactPreparationException("ZIP local/central flags or compression method are inconsistent.");
        bool descriptor = (entry.Flags & 0x0008) != 0;
        if (descriptor)
        {
            if (entry.LocalCrc32 != 0 && entry.LocalCrc32 != entry.Crc32 || entry.LocalCompressedSize != 0 && entry.LocalCompressedSize != entry.CompressedSize || entry.LocalUncompressedSize != 0 && entry.LocalUncompressedSize != entry.UncompressedSize) throw new ArtifactPreparationException("ZIP data-descriptor local values conflict with the central directory.");
        }
        else if (entry.LocalCrc32 != entry.Crc32 || entry.LocalCompressedSize != entry.CompressedSize || entry.LocalUncompressedSize != entry.UncompressedSize) throw new ArtifactPreparationException("ZIP local/central CRC or sizes are inconsistent.");
    }

    private static uint UpdateCrc32(uint crc, ReadOnlySpan<byte> bytes)
    {
        foreach (byte value in bytes) { crc ^= value; for (int bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ (0xedb88320u & (uint)-(int)(crc & 1)); }
        return crc;
    }

    private static string DecodeAsciiName(byte[] bytes) { if (bytes.Any(static value => value >= 0x80)) throw new ArtifactPreparationException("Non-UTF8 ZIP names must be ASCII."); return Encoding.ASCII.GetString(bytes); }
    private static ushort ReadUInt16(byte[] bytes, int offset) => (ushort)(bytes[offset] | bytes[offset + 1] << 8);
    private static uint ReadUInt32(byte[] bytes, int offset) => (uint)(bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24);

    private static bool ValidateEntryName(string name, out string relativePath)
    {
        if (string.IsNullOrEmpty(name) || name.Contains('\\') || name.StartsWith("/", StringComparison.Ordinal) || name.Length > 241) throw new ArtifactPreparationException("ZIP entry name is unsafe.");
        bool directory = name.EndsWith("/", StringComparison.Ordinal); relativePath = directory ? name[..^1] : name;
        if (relativePath.Length is 0 or > 240 || relativePath.Length >= 2 && char.IsAsciiLetter(relativePath[0]) && relativePath[1] == ':') throw new ArtifactPreparationException("ZIP relative path is unsafe.");
        foreach (string segment in relativePath.Split('/')) { if (segment.Length == 0 || segment is "." or ".." || segment.EndsWith(' ') || segment.EndsWith('.') || segment.Any(static c => c <= 0x1f || ":<>\"|?*".Contains(c))) throw new ArtifactPreparationException("ZIP path segment is unsafe."); if (DeviceNames.Contains(segment.Split('.')[0])) throw new ArtifactPreparationException("ZIP path uses a Windows device name."); }
        return directory;
    }

    private static void ValidateExternalAttributes(ZipArchiveEntry entry, bool directory)
    {
        int attributes = entry.ExternalAttributes; if ((((FileAttributes)(attributes & 0xffff)) & FileAttributes.ReparsePoint) != 0) throw new ArtifactPreparationException("ZIP entry has reparse attribute."); int type = ((attributes >> 16) & 0xffff) & 0xf000; if (type != 0 && (directory ? type != 0x4000 : type != 0x8000)) throw new ArtifactPreparationException("ZIP entry is a link or unsupported special file.");
    }

    private static void ValidatePrefixConflicts(IReadOnlyDictionary<string, bool> paths, string path, bool directory)
    {
        string[] segments = path.Split('/'); for (int i = 1; i < segments.Length; i++) { string prefix = string.Join("/", segments, 0, i); if (paths.TryGetValue(prefix, out bool isDirectory) && !isDirectory) throw new ArtifactPreparationException("ZIP has file-directory prefix conflict."); }
        if (!directory && paths.Keys.Any(candidate => candidate.StartsWith(path + "/", StringComparison.OrdinalIgnoreCase))) throw new ArtifactPreparationException("ZIP has directory-file prefix conflict.");
    }

    private static string NormalizeManifestPath(string value) { if (value.Contains('\\')) throw new ArtifactPreparationException("Manifest paths must use forward slashes."); _ = ValidateEntryName(value, out string normalized); return normalized; }
    private static bool SamePath(string left, string right) => string.Equals(left.Replace('\\', '/'), right.Replace('\\', '/'), StringComparison.OrdinalIgnoreCase);
    private static async Task<string> ReadTextBoundedAsync(Stream stream, long maxBytes, CancellationToken cancellationToken) { if (stream.Length > maxBytes || stream.Length > 16 * 1024 * 1024) throw new ArtifactPreparationException("manifest.json is too large."); stream.Seek(0, SeekOrigin.Begin); byte[] bytes = new byte[checked((int)stream.Length)]; await stream.ReadExactlyAsync(bytes, cancellationToken).ConfigureAwait(false); return StrictUtf8.GetString(bytes); }
    private static void CreatePreparedDirectory(string path)
    {
        if (!CreateDirectoryW(path, IntPtr.Zero)) throw new ArtifactPreparationException("Prepared partial directory could not be created exclusively.", new Win32Exception(Marshal.GetLastWin32Error()));
    }
    private static void TryDeleteUnpinnedEmptyRoot(string path)
    {
        try
        {
            using SafeFileHandle handle = CreateFileW(path, DeleteAccess, FileShare.ReadWrite, IntPtr.Zero, FileMode.Open, FileFlagOpenReparsePoint | FileFlagBackupSemantics, IntPtr.Zero);
            if (handle.IsInvalid || !GetFileInformationByHandle(handle, out ByHandleFileInformation info) || ((FileAttributes)info.FileAttributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory || info.NumberOfLinks != 1) return;
            var disposition = new FileDispositionInformation { DeleteFile = true }; _ = SetFileInformationByHandle(handle, FileInfoByHandleClass.FileDispositionInfo, ref disposition, (uint)Marshal.SizeOf<FileDispositionInformation>());
        }
        catch (Exception exception) { Debug.WriteLine("Unpinned empty prepared root cleanup failed: " + exception); }
    }
    private string SafeUniqueId() { string value = uniqueId(); if (string.IsNullOrWhiteSpace(value) || value.Length > 100 || value.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || value is "." or "..") throw new ArtifactPreparationException("UniqueId returned unsafe value."); return value; }
    private static void ValidateFormat(string url) { if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri)) throw new ArtifactPreparationException("Artifact URL is invalid."); string extension = Path.GetExtension(Uri.UnescapeDataString(uri.AbsolutePath)); if (!extension.Equals(".zip", StringComparison.OrdinalIgnoreCase)) throw new ArtifactPreparationException(extension.Equals(".7z", StringComparison.OrdinalIgnoreCase) ? "7z artifacts are not supported." : "Only ZIP artifacts are supported."); }
    private sealed record ValidatedEntry(ZipArchiveEntry Entry, CentralEntry Central, string RelativePath, bool IsDirectory);
    private sealed record CentralEntry(string Name, ushort Flags, ushort Method, uint Crc32, uint CompressedSize, uint UncompressedSize, uint LocalHeaderOffset, ushort LocalFlags, ushort LocalMethod, uint LocalCrc32, uint LocalCompressedSize, uint LocalUncompressedSize);
    private readonly record struct LocalEntry(ushort Flags, ushort Method, uint Crc32, uint CompressedSize, uint UncompressedSize);
    private const uint DeleteAccess = 0x00010000; private const uint FileFlagBackupSemantics = 0x02000000; private const uint FileFlagOpenReparsePoint = 0x00200000;
    private enum FileInfoByHandleClass { FileDispositionInfo = 4 }
    [StructLayout(LayoutKind.Sequential)] private struct FileDispositionInformation { [MarshalAs(UnmanagedType.Bool)] internal bool DeleteFile; }
    [StructLayout(LayoutKind.Sequential)] private struct ByHandleFileInformation { internal uint FileAttributes; internal System.Runtime.InteropServices.ComTypes.FILETIME CreationTime; internal System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime; internal System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime; internal uint VolumeSerialNumber; internal uint FileSizeHigh; internal uint FileSizeLow; internal uint NumberOfLinks; internal uint FileIndexHigh; internal uint FileIndexLow; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)] private static extern SafeFileHandle CreateFileW(string fileName, uint desiredAccess, FileShare shareMode, IntPtr securityAttributes, FileMode creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateDirectoryW(string pathName, IntPtr securityAttributes);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out ByHandleFileInformation fileInformation);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetFileInformationByHandle(SafeFileHandle file, FileInfoByHandleClass informationClass, ref FileDispositionInformation information, uint bufferSize);
}
