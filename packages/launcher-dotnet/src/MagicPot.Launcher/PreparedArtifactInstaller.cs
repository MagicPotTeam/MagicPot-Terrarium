using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace MagicPot.Launcher;

internal sealed class PreparedArtifactInstallationException : Exception
{
    internal PreparedArtifactInstallationException(string message) : base(message) { }
    internal PreparedArtifactInstallationException(string message, Exception innerException) : base(message, innerException) { }
}

internal sealed class PreparedArtifactInstallerOptions
{
    internal required string Root { get; init; }
    internal TimeSpan LockTimeout { get; init; } = TimeSpan.FromSeconds(30);
    internal TimeSpan LockRetryDelay { get; init; } = TimeSpan.FromMilliseconds(50);
    internal Func<string>? UniqueId { get; init; }
    internal Action<string>? BeforeFileCopy { get; init; }
    internal Action? BeforePublish { get; init; }
    internal Action? BeforeCleanupAttempt { get; init; }
    internal Func<string, string, bool>? MoveFile { get; init; }
    internal Action? AfterMoveBeforeReopen { get; init; }
}

internal sealed record InstalledFileIdentity(uint VolumeSerialNumber, ulong FileId);
internal sealed record PinnedFileSnapshot(InstalledFileIdentity Identity, long Length, byte[] Sha256);
internal sealed record InstalledTreeSnapshot(InstalledFileIdentity RootIdentity, IReadOnlyDictionary<string, InstalledFileIdentity> Directories, IReadOnlyDictionary<string, PinnedFileSnapshot> Files, IReadOnlySet<string> ExactDirectories, IReadOnlySet<string> ExactFiles);

internal sealed class InstalledArtifactReceipt : IDisposable, IAsyncDisposable
{
    private InstalledTreeVerifier? verifier;

    internal InstalledArtifactReceipt(string kind, string id, object manifest, string finalPath, bool alreadyInstalled, InstalledTreeVerifier verifier)
    {
        Kind = kind; Id = id; Manifest = manifest; FinalPath = finalPath; AlreadyInstalled = alreadyInstalled; this.verifier = verifier;
        FinalIdentity = verifier.Identity;
    }

    internal string Kind { get; }
    internal string Id { get; }
    internal object Manifest { get; }
    internal string FinalPath { get; }
    internal InstalledFileIdentity FinalIdentity { get; }
    internal InstalledFileIdentity Identity => FinalIdentity;
    internal bool AlreadyInstalled { get; }

    internal void ValidateStillPinned() => ValidateForActivation();
    internal void ValidateForActivation() => (verifier ?? throw new ObjectDisposedException(nameof(InstalledArtifactReceipt))).ValidateForActivation();
    // Coordinator-only launch boundary: call immediately before CreateProcess, with no await or callback between them.
    internal void ValidateImmediatelyBeforeLaunch() => ValidateForActivation();
    public void Dispose() { verifier?.Dispose(); verifier = null; }
    public ValueTask DisposeAsync() { Dispose(); return ValueTask.CompletedTask; }
}

internal sealed class InstallerCleanupTicket
{
    private readonly object gate = new();
    private InstallPinnedTree? tree;
    internal InstallerCleanupTicket(InstallPinnedTree tree) => this.tree = tree;
    internal bool CleanupCompleted { get { lock (gate) return tree is null; } }
    internal bool RetryCleanup()
    {
        lock (gate)
        {
            if (tree is null) return true;
            try { tree.Cleanup(); tree = null; return true; } catch { return false; }
        }
    }
}

internal static class InstallerCleanupRegistry
{
    private static readonly ConcurrentDictionary<long, InstallerCleanupTicket> Pending = new();
    private static readonly Timer RetryTimer = new(static _ => RunOnePass(), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
    private static long nextId;
    internal static int PendingCount => Pending.Count;
    internal static void Register(InstallerCleanupTicket ticket) { Pending.TryAdd(Interlocked.Increment(ref nextId), ticket); GC.KeepAlive(RetryTimer); }
    internal static void RunOnePass() { foreach (KeyValuePair<long, InstallerCleanupTicket> item in Pending) if (item.Value.RetryCleanup()) Pending.TryRemove(item.Key, out _); }
}

internal sealed class PreparedArtifactInstaller
{
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private readonly string root;
    private readonly TimeSpan lockTimeout;
    private readonly TimeSpan lockRetryDelay;
    private readonly Func<string> uniqueId;
    private readonly Action<string>? beforeFileCopy;
    private readonly Action? beforePublish;
    private readonly Action? beforeCleanupAttempt;
    private readonly Func<string, string, bool> moveFile;
    private readonly Action? afterMoveBeforeReopen;

    internal PreparedArtifactInstaller(PreparedArtifactInstallerOptions options)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("PreparedArtifactInstaller is Windows-only.");
        ArgumentNullException.ThrowIfNull(options);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.Root);
        if (!Path.IsPathFullyQualified(options.Root)) throw new ArgumentException("Root must be absolute.", nameof(options));
        if (options.LockTimeout <= TimeSpan.Zero || options.LockRetryDelay <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(options));
        root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(options.Root));
        lockTimeout = options.LockTimeout;
        lockRetryDelay = options.LockRetryDelay;
        uniqueId = options.UniqueId ?? (static () => Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture));
        beforeFileCopy = options.BeforeFileCopy;
        beforePublish = options.BeforePublish;
        beforeCleanupAttempt = options.BeforeCleanupAttempt;
        moveFile = options.MoveFile ?? InstallNative.Move;
        afterMoveBeforeReopen = options.AfterMoveBeforeReopen;
    }

    // Ownership of package is never transferred, on success or failure.
    internal async Task<InstalledArtifactReceipt> InstallAsync(PreparedArtifactPackage package, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(package);
        Descriptor descriptor = Describe(package);
        using var chain = new InstallAncestorChain(root, descriptor.Container);
        descriptor = descriptor with { FinalPath = Path.Combine(chain.ContainerPath, descriptor.Id) };
        WindowsNamedMutexLease lease;
        try { lease = await WindowsNamedMutexLease.AcquireAsync(descriptor.MutexName, lockTimeout, lockRetryDelay, cancellationToken).ConfigureAwait(false); }
        catch (TimeoutException exception) { throw new PreparedArtifactInstallationException("Install lock timed out.", exception); }
        await using (lease.ConfigureAwait(false))
        {
            await using FileStream lockFile = await chain.OpenLockAsync(descriptor.Id + ".install.lock", lockTimeout, lockRetryDelay, cancellationToken).ConfigureAwait(false);
            if (Directory.Exists(descriptor.FinalPath))
            {
                try { return await ValidateExistingAsync(package, descriptor, chain, cancellationToken).ConfigureAwait(false); }
                catch (OperationCanceledException) { throw; }
                catch (PreparedArtifactInstallationException) { throw; }
                catch (Exception exception) { throw new PreparedArtifactInstallationException("Existing install target could not be safely validated.", exception); }
            }
            if (File.Exists(descriptor.FinalPath)) throw new PreparedArtifactInstallationException("Install target exists and is not a directory.");
            string partial = Path.Combine(chain.ContainerPath, descriptor.Id + ".partial-" + SafeUniqueId());
            InstallPinnedTree? tree = null;
            try
            {
                chain.CreateExclusive(partial);
                tree = InstallPinnedTree.CreatePartial(partial, chain, beforeCleanupAttempt);
                string[] entries = FreezeEntries(package);
                ExpectedTree expectedTree = CreateExpectedTree(package, entries);
                IReadOnlyList<InstalledFileV1> files = RequireFiles(package.Manifest);
                Dictionary<string, InstalledFileV1> expected = files.ToDictionary(static value => Normalize(value.Path), StringComparer.OrdinalIgnoreCase);
                foreach (string relative in entries)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (relative.EndsWith("/", StringComparison.Ordinal))
                    {
                        tree.EnsureDirectories(relative[..^1].Split('/'));
                        continue;
                    }
                    beforeFileCopy?.Invoke(relative);
                    string[] segments = relative.Split('/');
                    tree.EnsureDirectories(segments[..^1]);
                    using Stream source = package.OpenRead(relative);
                    InstalledFileV1? expectedFile = expected.GetValueOrDefault(relative);
                    long expectedLength = expectedFile?.Size ?? source.Length;
                    FileStream destination = tree.CreateFile(relative);
                    using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                    byte[] buffer = new byte[131_072]; long written = 0;
                    while (true)
                    {
                        int count = await source.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false);
                        if (count == 0) break;
                        written = checked(written + count);
                        if (written > expectedLength) throw new PreparedArtifactInstallationException("Source exceeded expected length: " + relative);
                        hash.AppendData(buffer, 0, count);
                        await destination.WriteAsync(buffer.AsMemory(0, count), cancellationToken).ConfigureAwait(false);
                    }
                    if (written != expectedLength) throw new PreparedArtifactInstallationException("Source length mismatch: " + relative);
                    if (expectedFile is not null && !CryptographicOperations.FixedTimeEquals(hash.GetHashAndReset(), Convert.FromHexString(expectedFile.Sha256))) throw new PreparedArtifactInstallationException("Source hash mismatch: " + relative);
                    await destination.FlushAsync(cancellationToken).ConfigureAwait(false); destination.Flush(true); destination.Position = 0; tree.ValidateFile(relative);
                }
                await ValidateTreeAsync(package, descriptor, expectedTree, tree, cancellationToken).ConfigureAwait(false);
                beforePublish?.Invoke(); chain.Validate();
                InstalledTreeSnapshot snapshot = tree.CaptureSnapshotAndDetachForPublish();
                bool moved = moveFile(tree.PublishSourcePath, InstallNative.Normalize(descriptor.FinalPath));
                int moveError = moved ? 0 : Marshal.GetLastWin32Error();
                if (!moved)
                {
                    tree.ReopenPartialAfterFailedMove(snapshot, moveError);
                    throw new PreparedArtifactInstallationException("MoveFileExW publish failed.", new Win32Exception(moveError));
                }

                tree.MarkPublished();
                InstalledTreeVerifier? verifier = null;
                try
                {
                    afterMoveBeforeReopen?.Invoke();
                    verifier = InstalledTreeVerifier.Open(descriptor.FinalPath, expectedTree.Files, expectedTree.Directories);
                    verifier.VerifyAgainstSnapshot(snapshot);
                    chain.Validate();
                    tree.Dispose(); tree = null;
                    return new InstalledArtifactReceipt(descriptor.Kind, descriptor.Id, package.Manifest, descriptor.FinalPath, false, verifier);
                }
                catch (Exception exception)
                {
                    verifier?.Dispose();
                    Debug.WriteLine("SECURITY ORPHAN FINAL: post-move verification failed; preserving final '" + descriptor.FinalPath + "': " + exception);
                    throw new PreparedArtifactInstallationException("Publish post-move validation failed; orphan final is preserved and no receipt is returned.", exception);
                }
            }
            catch (Exception exception)
            {
                if (tree is not null)
                {
                    try { tree.Cleanup(); }
                    catch (Exception cleanup)
                    {
                        Debug.WriteLine("Installer cleanup failed without masking primary error: " + cleanup);
                        InstallerCleanupRegistry.Register(new InstallerCleanupTicket(tree));
                        tree = null;
                    }
                }
                if (exception is PreparedArtifactInstallationException or OperationCanceledException) throw;
                throw new PreparedArtifactInstallationException("Prepared artifact installation failed closed.", exception);
            }
        }
    }

    private static async Task<InstalledArtifactReceipt> ValidateExistingAsync(PreparedArtifactPackage package, Descriptor descriptor, InstallAncestorChain chain, CancellationToken cancellationToken)
    {
        string[] entries = FreezeEntries(package);
        ExpectedTree expected = CreateExpectedTree(package, entries);
        InstalledTreeVerifier verifier = InstalledTreeVerifier.Open(descriptor.FinalPath, expected.Files, expected.Directories);
        try
        {
            await ValidateTreeAsync(package, descriptor, expected, verifier, cancellationToken).ConfigureAwait(false);
            verifier.CaptureActivationBaseline();
            return new InstalledArtifactReceipt(descriptor.Kind, descriptor.Id, package.Manifest, descriptor.FinalPath, true, verifier);
        }
        catch { verifier.Dispose(); throw; }
    }

    private static Task ValidateTreeAsync(PreparedArtifactPackage package, Descriptor descriptor, ExpectedTree expected, InstallPinnedTree tree, CancellationToken cancellationToken) =>
        ValidateTreeAsync(package, descriptor, expected, tree.OpenRead, tree.EnumerateAndPin, tree.ValidateAll, cancellationToken);

    private static Task ValidateTreeAsync(PreparedArtifactPackage package, Descriptor descriptor, ExpectedTree expected, InstalledTreeVerifier verifier, CancellationToken cancellationToken) =>
        ValidateTreeAsync(package, descriptor, expected, verifier.OpenRead, verifier.EnumerateCurrent, verifier.ValidateAll, cancellationToken);

    private static async Task ValidateTreeAsync(PreparedArtifactPackage package, Descriptor descriptor, ExpectedTree expected, Func<string, Stream> openRead, Func<TreePaths> enumerate, Action validateAll, CancellationToken cancellationToken)
    {
        object parsed;
        using (Stream manifest = openRead("manifest.json"))
        {
            if (manifest.Length > 16 * 1024 * 1024) throw new PreparedArtifactInstallationException("manifest.json is too large.");
            byte[] bytes = new byte[checked((int)manifest.Length)]; await manifest.ReadExactlyAsync(bytes, cancellationToken).ConfigureAwait(false);
            parsed = descriptor.Kind == "app" ? Protocol.ParseAppManifest(StrictUtf8.GetString(bytes)) : Protocol.ParseRuntimeManifest(StrictUtf8.GetString(bytes));
        }
        RequireManifestEqual(package.Manifest, parsed); RequireIdentityEqual(package.Identity, parsed);
        TreePaths actual = enumerate();
        if (!actual.Files.SetEquals(expected.Files) || !actual.Directories.SetEquals(expected.Directories)) throw new PreparedArtifactInstallationException("Destination has missing or extra files or directories.");
        foreach (InstalledFileV1 file in RequireFiles(parsed))
        {
            string relative = Normalize(file.Path); using Stream input = openRead(relative);
            if (input.Length != file.Size) throw new PreparedArtifactInstallationException("Destination size mismatch: " + relative);
            byte[] digest = await SHA256.HashDataAsync(input, cancellationToken).ConfigureAwait(false);
            if (!CryptographicOperations.FixedTimeEquals(digest, Convert.FromHexString(file.Sha256))) throw new PreparedArtifactInstallationException("Destination hash mismatch: " + relative);
        }
        foreach (string entrypoint in Entrypoints(parsed)) using (openRead(Normalize(entrypoint))) { }
        validateAll();
        TreePaths finalActual = enumerate();
        if (!finalActual.Files.SetEquals(expected.Files) || !finalActual.Directories.SetEquals(expected.Directories)) throw new PreparedArtifactInstallationException("Destination tree changed during content verification.");
    }

    private Descriptor Describe(PreparedArtifactPackage package)
    {
        string kind; string id; string container;
        if (package.Kind == "app" && package.Manifest is InstalledAppManifestV1 app) { kind = "app"; id = app.BuildId; container = "apps"; if (package.Identity.Kind != kind || package.Identity.BuildId != id) throw new PreparedArtifactInstallationException("App identity cannot override manifest target."); }
        else if (package.Kind == "runtime" && package.Manifest is InstalledRuntimeManifestV1 runtime) { kind = "runtime"; id = runtime.RuntimeId; container = "runtimes"; if (package.Identity.Kind != kind || package.Identity.RuntimeId != id) throw new PreparedArtifactInstallationException("Runtime identity cannot override manifest target."); }
        else throw new PreparedArtifactInstallationException("Unsupported or inconsistent prepared package.");
        if (string.IsNullOrWhiteSpace(id) || id.Length > 120 || id is "." or ".." || id.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || id.Contains('/') || id.Contains('\\')) throw new PreparedArtifactInstallationException("Unsafe manifest install identifier.");
        string material = root.ToUpperInvariant() + "\n" + kind + "\n" + id;
        return new Descriptor(kind, id, container, string.Empty, @"Local\MagicPot.PreparedArtifactInstaller." + Convert.ToHexString(SHA256.HashData(StrictUtf8.GetBytes(material))));
    }

    private static string[] FreezeEntries(PreparedArtifactPackage package)
    {
        string[] entries = package.Entries.Select(static value => value.EndsWith("/", StringComparison.Ordinal) ? Normalize(value[..^1]) + "/" : Normalize(value)).OrderBy(static value => value, StringComparer.OrdinalIgnoreCase).ToArray();
        if (entries.Length != entries.Distinct(StringComparer.OrdinalIgnoreCase).Count() || !entries.Contains("manifest.json", StringComparer.OrdinalIgnoreCase)) throw new PreparedArtifactInstallationException("Invalid prepared package entry set.");
        return entries;
    }
    private static ExpectedTree CreateExpectedTree(PreparedArtifactPackage package, IEnumerable<string> entries)
    {
        var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var directories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string entry in entries)
        {
            bool directory = entry.EndsWith("/", StringComparison.Ordinal);
            string relative = directory ? entry[..^1] : entry;
            if (directory) directories.Add(relative); else files.Add(relative);
            AddParents(relative, directories);
        }
        foreach (InstalledFileV1 file in RequireFiles(package.Manifest))
        {
            string relative = Normalize(file.Path);
            if (!files.Contains(relative)) throw new PreparedArtifactInstallationException("manifest.files path is absent from prepared package entries.");
            AddParents(relative, directories);
        }
        if (files.Overlaps(directories)) throw new PreparedArtifactInstallationException("Prepared package path is both file and directory.");
        return new ExpectedTree(files, directories);
    }
    private static void AddParents(string relative, ISet<string> directories)
    {
        int slash = relative.IndexOf('/');
        while (slash >= 0)
        {
            directories.Add(relative[..slash]);
            slash = relative.IndexOf('/', slash + 1);
        }
    }
    private static IReadOnlyList<InstalledFileV1> RequireFiles(object manifest)
    {
        IReadOnlyList<InstalledFileV1>? files = manifest switch { InstalledAppManifestV1 app => app.Files, InstalledRuntimeManifestV1 runtime => runtime.Files, _ => null };
        if (files is null || files.Count == 0) throw new PreparedArtifactInstallationException("Installer requires non-empty manifest.files for secure idempotence.");
        if (files.Select(static value => Normalize(value.Path)).ToHashSet(StringComparer.OrdinalIgnoreCase).Count != files.Count) throw new PreparedArtifactInstallationException("Duplicate manifest.files path.");
        return files;
    }
    private static string[] Entrypoints(object manifest) => manifest switch { InstalledAppManifestV1 app => [app.Entrypoint], InstalledRuntimeManifestV1 runtime => [runtime.Entrypoints.Python, runtime.Entrypoints.Comfyui], _ => throw new PreparedArtifactInstallationException("Unsupported manifest.") };
    private static string Normalize(string path) { if (string.IsNullOrWhiteSpace(path) || path.Contains('\\') || Path.IsPathFullyQualified(path) || path.Split('/').Any(static value => value is "" or "." or ".." || value.EndsWith(' ') || value.EndsWith('.'))) throw new PreparedArtifactInstallationException("Unsafe relative path."); return path; }
    private static bool SamePath(string left, string right) => string.Equals(left.Replace('\\', '/'), right.Replace('\\', '/'), StringComparison.OrdinalIgnoreCase);
    private static bool SameFiles(IReadOnlyList<InstalledFileV1>? left, IReadOnlyList<InstalledFileV1>? right) { if (left is null || right is null || left.Count != right.Count) return false; Dictionary<string, InstalledFileV1> map = left.ToDictionary(static value => Normalize(value.Path), StringComparer.OrdinalIgnoreCase); return right.All(value => map.TryGetValue(Normalize(value.Path), out InstalledFileV1? item) && item.Size == value.Size && string.Equals(item.Sha256, value.Sha256, StringComparison.OrdinalIgnoreCase)); }
    private static void RequireManifestEqual(object expected, object actual)
    {
        bool equal = expected switch { InstalledAppManifestV1 a when actual is InstalledAppManifestV1 b => a.Schema == b.Schema && a.Kind == b.Kind && a.Version == b.Version && a.BuildId == b.BuildId && a.CommitSha == b.CommitSha && a.Platform == b.Platform && a.Arch == b.Arch && a.RuntimeId == b.RuntimeId && SamePath(a.Entrypoint, b.Entrypoint) && a.CreatedAt == b.CreatedAt && a.UnpackedSize == b.UnpackedSize && SameFiles(a.Files, b.Files), InstalledRuntimeManifestV1 a when actual is InstalledRuntimeManifestV1 b => a.Schema == b.Schema && a.Kind == b.Kind && a.RuntimeId == b.RuntimeId && a.Platform == b.Platform && a.Arch == b.Arch && a.CreatedAt == b.CreatedAt && SamePath(a.Entrypoints.Python, b.Entrypoints.Python) && SamePath(a.Entrypoints.Comfyui, b.Entrypoints.Comfyui) && a.UnpackedSize == b.UnpackedSize && SameFiles(a.Files, b.Files), _ => false };
        if (!equal) throw new PreparedArtifactInstallationException("Destination manifest differs from package manifest.");
    }
    private static void RequireIdentityEqual(ArtifactDownloadIdentity identity, object manifest)
    {
        bool equal = manifest switch { InstalledAppManifestV1 app => identity.Kind == "app" && identity.Version == app.Version && identity.BuildId == app.BuildId && identity.CommitSha == app.CommitSha && identity.RuntimeId == app.RuntimeId && identity.Platform == app.Platform && identity.Arch == app.Arch && SamePath(identity.Entrypoint, app.Entrypoint), InstalledRuntimeManifestV1 runtime => identity.Kind == "runtime" && identity.RuntimeId == runtime.RuntimeId && identity.Platform == runtime.Platform && identity.Arch == runtime.Arch && SamePath(identity.Entrypoint, runtime.Entrypoints.Python), _ => false };
        if (!equal) throw new PreparedArtifactInstallationException("Destination identity differs from signed package identity.");
    }
    private string SafeUniqueId() { string value = uniqueId(); if (string.IsNullOrWhiteSpace(value) || value.Length > 100 || value is "." or ".." || value.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) throw new PreparedArtifactInstallationException("Unsafe unique ID."); return value; }
    private sealed record Descriptor(string Kind, string Id, string Container, string FinalPath, string MutexName);
    private sealed record ExpectedTree(HashSet<string> Files, HashSet<string> Directories);
}

internal sealed record TreePaths(HashSet<string> Files, HashSet<string> Directories);

internal sealed class InstallAncestorChain : IDisposable
{
    private readonly List<(string Path, SafeFileHandle Handle)> handles = [];
    private readonly FileShare share;
    internal InstallAncestorChain(string root, string container, FileShare share = FileShare.ReadWrite, bool requireContainerCreateAccess = true) { Root = root; ContainerPath = Path.Combine(root, container); this.share = share; try { PinTo(Root, requireContainerCreateAccess); PinTo(ContainerPath, requireContainerCreateAccess); Validate(); } catch { Dispose(); throw; } }
    internal string Root { get; } internal string ContainerPath { get; } internal SafeFileHandle ContainerHandle => handles[^1].Handle; internal string CanonicalContainer => InstallNative.Canonical(ContainerHandle);
    internal void Validate() { foreach ((string path, SafeFileHandle handle) in handles) InstallNative.ValidateDirectory(handle, path); }
    internal void CreateExclusive(string path) { Validate(); if (!InstallNative.CreateDirectoryW(path, IntPtr.Zero)) throw new PreparedArtifactInstallationException("Unique partial collision or create failure.", new Win32Exception(Marshal.GetLastWin32Error())); Validate(); }
    internal async Task<FileStream> OpenLockAsync(string name, TimeSpan timeout, TimeSpan retryDelay, CancellationToken cancellationToken)
    {
        string path = Path.Combine(ContainerPath, name);
        var stopwatch = Stopwatch.StartNew();
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            SafeFileHandle handle = InstallNative.CreateFileW(path, InstallNative.GenericRead | InstallNative.GenericWrite, FileShare.None, IntPtr.Zero, FileMode.OpenOrCreate, InstallNative.OpenReparse | InstallNative.WriteThrough, IntPtr.Zero);
            if (!handle.IsInvalid)
            {
                try { InstallNative.ValidateFile(handle, path); return new FileStream(handle, FileAccess.ReadWrite); }
                catch { handle.Dispose(); throw; }
            }

            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            var exception = new Win32Exception(error);
            if (error is not (5 or 32 or 33)) throw new PreparedArtifactInstallationException("Safe lock file open failed.", exception);
            if (stopwatch.Elapsed >= timeout) throw new PreparedArtifactInstallationException("Install file lock timed out.", exception);
            TimeSpan remaining = timeout - stopwatch.Elapsed;
            await Task.Delay(remaining < retryDelay ? remaining : retryDelay, cancellationToken).ConfigureAwait(false);
        }
    }
    private void PinTo(string target, bool requireContainerCreateAccess) { string volume = Path.GetPathRoot(target) ?? throw new PreparedArtifactInstallationException("Root has no volume."); string current = volume; if (handles.Count == 0) Pin(current, requireContainerCreateAccess); foreach (string segment in target[volume.Length..].Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)) { if (segment.Length == 0) continue; current = Path.Combine(current, segment); if (handles.Any(item => string.Equals(item.Path, InstallNative.Normalize(current), StringComparison.OrdinalIgnoreCase))) continue; if (!Directory.Exists(current) && !InstallNative.CreateDirectoryW(current, IntPtr.Zero) && Marshal.GetLastWin32Error() != 183) throw new PreparedArtifactInstallationException("Layout create failed.", new Win32Exception(Marshal.GetLastWin32Error())); Pin(current, requireContainerCreateAccess); } }
    private void Pin(string path, bool requireContainerCreateAccess)
    {
        uint access = InstallNative.ReadAttributes;
        if (requireContainerCreateAccess && string.Equals(InstallNative.Normalize(path), InstallNative.Normalize(ContainerPath), StringComparison.OrdinalIgnoreCase)) access |= InstallNative.FileAddSubdirectory;
        SafeFileHandle handle = InstallNative.OpenDirectory(path, access, share);
        try { InstallNative.ValidateDirectory(handle, path); handles.Add((InstallNative.Normalize(path), handle)); } catch { handle.Dispose(); throw; }
    }
    public void Dispose() { for (int i = handles.Count - 1; i >= 0; i--) handles[i].Handle.Dispose(); handles.Clear(); }
}

internal sealed class InstalledTreeVerifier : IDisposable
{
    private readonly Dictionary<string, SafeFileHandle> directories = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, FileStream> files = new(StringComparer.OrdinalIgnoreCase);
    private readonly InstallAncestorChain ancestorChain;
    private readonly string canonicalRoot;
    private InstalledTreeSnapshot? activationBaseline;

    private InstalledTreeVerifier(string root, SafeFileHandle rootHandle, InstallAncestorChain ancestorChain)
    {
        Root = root;
        this.ancestorChain = ancestorChain;
        canonicalRoot = InstallNative.Canonical(rootHandle);
        directories.Add(string.Empty, rootHandle);
    }

    private string Root { get; }
    internal InstalledFileIdentity Identity => InstallNative.Identity(directories[string.Empty]);

    internal static InstalledTreeVerifier Open(string root, IReadOnlySet<string> expectedFiles, IReadOnlySet<string> expectedDirectories)
    {
        string finalPath = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        string containerPath = Path.GetDirectoryName(finalPath) ?? throw new PreparedArtifactInstallationException("Install root has no container.");
        string launcherRoot = Path.GetDirectoryName(containerPath) ?? throw new PreparedArtifactInstallationException("Install container has no launcher root.");
        string container = Path.GetFileName(containerPath);
        var chain = new InstallAncestorChain(launcherRoot, container, FileShare.Read, requireContainerCreateAccess: false);
        SafeFileHandle? rootHandle = null;
        InstalledTreeVerifier? verifier = null;
        try
        {
            chain.Validate();
            if (!string.Equals(InstallNative.Normalize(containerPath), InstallNative.Normalize(chain.ContainerPath), StringComparison.OrdinalIgnoreCase)) throw new PreparedArtifactInstallationException("Install root container does not match its ancestor chain.");
            SafeFileHandle openedRoot = InstallNative.OpenDirectory(finalPath, InstallNative.GenericRead, FileShare.Read);
            rootHandle = openedRoot;
            InstallNative.ValidateDirectory(openedRoot, finalPath);
            string canonicalParent = Path.GetDirectoryName(InstallNative.Canonical(openedRoot)) ?? string.Empty;
            if (!string.Equals(canonicalParent, chain.CanonicalContainer, StringComparison.OrdinalIgnoreCase)) throw new PreparedArtifactInstallationException("Install root escaped container.");
            verifier = new InstalledTreeVerifier(finalPath, openedRoot, chain);
            rootHandle = null;
            verifier.PinAll();
            TreePaths actual = verifier.EnumeratePinned();
            if (!actual.Files.SetEquals(expectedFiles) || !actual.Directories.SetEquals(expectedDirectories)) throw new PreparedArtifactInstallationException("Existing destination has missing or extra files or directories.");
            verifier.RequireSecondEnumerationMatchesPinned();
            verifier.ValidateAll();
            return verifier;
        }
        catch
        {
            if (verifier is null) { rootHandle?.Dispose(); chain.Dispose(); } else verifier.Dispose();
            throw;
        }
    }

    internal Stream OpenRead(string relative)
    {
        if (!files.TryGetValue(relative, out FileStream? file)) throw new PreparedArtifactInstallationException("Destination file is not pinned: " + relative);
        InstallNative.ValidateFile(file.SafeFileHandle, Physical(relative));
        if (!InstallNative.DuplicateHandle(InstallNative.GetCurrentProcess(), file.SafeFileHandle, InstallNative.GetCurrentProcess(), out SafeFileHandle duplicate, InstallNative.GenericRead, false, 0)) throw new PreparedArtifactInstallationException("DuplicateHandle failed.");
        var result = new FileStream(duplicate, FileAccess.Read); result.Position = 0; return result;
    }

    internal TreePaths EnumeratePinned() => new(files.Keys.ToHashSet(StringComparer.OrdinalIgnoreCase), directories.Keys.Where(static value => value.Length != 0).ToHashSet(StringComparer.OrdinalIgnoreCase));
    internal TreePaths EnumerateCurrent() => EnumeratePaths();

    internal void ValidateAll()
    {
        foreach (KeyValuePair<string, SafeFileHandle> item in directories) InstallNative.ValidateDirectory(item.Value, Physical(item.Key));
        foreach (KeyValuePair<string, FileStream> item in files) InstallNative.ValidateFile(item.Value.SafeFileHandle, Physical(item.Key));
    }

    private void PinAll()
    {
        foreach (FileSystemInfo item in EnumerateTree())
        {
            string relative = Path.GetRelativePath(Root, item.FullName).Replace('\\', '/');
            if ((item.Attributes & FileAttributes.ReparsePoint) != 0) throw new PreparedArtifactInstallationException("Reparse point in destination.");
            if ((item.Attributes & FileAttributes.Directory) != 0)
            {
                SafeFileHandle handle = InstallNative.OpenDirectory(item.FullName, InstallNative.GenericRead, FileShare.Read);
                try { InstallNative.ValidateDirectory(handle, item.FullName); directories.Add(relative, handle); } catch { handle.Dispose(); throw; }
            }
            else
            {
                SafeFileHandle handle = InstallNative.CreateFileW(item.FullName, InstallNative.GenericRead, FileShare.Read, IntPtr.Zero, FileMode.Open, InstallNative.OpenReparse, IntPtr.Zero);
                if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new PreparedArtifactInstallationException("Existing file pin failed.", new Win32Exception(error)); }
                try { InstallNative.ValidateFile(handle, item.FullName); files.Add(relative, new FileStream(handle, FileAccess.Read)); } catch { handle.Dispose(); throw; }
            }
        }
    }

    private void RequireSecondEnumerationMatchesPinned()
    {
        TreePaths actual = EnumeratePaths();
        if (!actual.Files.SetEquals(files.Keys) || !actual.Directories.SetEquals(directories.Keys.Where(static value => value.Length != 0))) throw new PreparedArtifactInstallationException("Destination tree changed during verification.");
    }

    private TreePaths EnumeratePaths()
    {
        var actualFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var actualDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (FileSystemInfo item in EnumerateTree())
        {
            if ((item.Attributes & FileAttributes.ReparsePoint) != 0) throw new PreparedArtifactInstallationException("Reparse point appeared during destination verification.");
            string relative = Path.GetRelativePath(Root, item.FullName).Replace('\\', '/');
            if ((item.Attributes & FileAttributes.Directory) != 0) actualDirectories.Add(relative); else actualFiles.Add(relative);
        }
        return new TreePaths(actualFiles, actualDirectories);
    }

    private IEnumerable<FileSystemInfo> EnumerateTree()
    {
        var pending = new Queue<DirectoryInfo>();
        pending.Enqueue(new DirectoryInfo(Root));
        while (pending.Count != 0)
        {
            foreach (FileSystemInfo item in pending.Dequeue().EnumerateFileSystemInfos())
            {
                yield return item;
                if ((item.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == FileAttributes.Directory) pending.Enqueue((DirectoryInfo)item);
            }
        }
    }

    internal void VerifyAgainstSnapshot(InstalledTreeSnapshot snapshot)
    {
        ValidateAll();
        TreePaths actual = EnumerateCurrent();
        if (!actual.Files.SetEquals(snapshot.ExactFiles) || !actual.Directories.SetEquals(snapshot.ExactDirectories)) throw new PreparedArtifactInstallationException("Published tree path set differs from pre-publish snapshot.");
        if (Identity != snapshot.RootIdentity) throw new PreparedArtifactInstallationException("Published root identity differs from pre-publish snapshot.");
        foreach (KeyValuePair<string, InstalledFileIdentity> item in snapshot.Directories)
            if (!directories.TryGetValue(item.Key, out SafeFileHandle? handle) || InstallNative.Identity(handle) != item.Value) throw new PreparedArtifactInstallationException("Published directory identity differs from pre-publish snapshot: " + item.Key);
        foreach (KeyValuePair<string, PinnedFileSnapshot> item in snapshot.Files)
        {
            if (!files.TryGetValue(item.Key, out FileStream? file) || InstallNative.Identity(file.SafeFileHandle) != item.Value.Identity) throw new PreparedArtifactInstallationException("Published file identity differs from pre-publish snapshot: " + item.Key);
            file.Position = 0;
            if (file.Length != item.Value.Length || !CryptographicOperations.FixedTimeEquals(SHA256.HashData(file), item.Value.Sha256)) throw new PreparedArtifactInstallationException("Published file content differs from pre-publish snapshot: " + item.Key);
            file.Position = 0;
        }
        RequireSecondEnumerationMatchesPinned();
        activationBaseline = snapshot;
    }

    internal void CaptureActivationBaseline() => activationBaseline = CaptureCurrentSnapshot();

    internal void ValidateForActivation()
    {
        ancestorChain.Validate();
        if (!string.Equals(Path.GetDirectoryName(canonicalRoot), ancestorChain.CanonicalContainer, StringComparison.OrdinalIgnoreCase)) throw new PreparedArtifactInstallationException("Pinned install root escaped its ancestor chain.");
        InstalledTreeSnapshot expected = activationBaseline ?? throw new PreparedArtifactInstallationException("Pinned receipt has no activation baseline.");
        VerifyAgainstSnapshot(expected);
    }

    private InstalledTreeSnapshot CaptureCurrentSnapshot()
    {
        ValidateAll();
        TreePaths paths = EnumerateCurrent();
        var directoryIdentities = directories.ToDictionary(static item => item.Key, static item => InstallNative.Identity(item.Value), StringComparer.OrdinalIgnoreCase);
        var fileSnapshots = new Dictionary<string, PinnedFileSnapshot>(StringComparer.OrdinalIgnoreCase);
        foreach (KeyValuePair<string, FileStream> item in files)
        {
            item.Value.Position = 0;
            fileSnapshots.Add(item.Key, new PinnedFileSnapshot(InstallNative.Identity(item.Value.SafeFileHandle), item.Value.Length, SHA256.HashData(item.Value)));
            item.Value.Position = 0;
        }
        return new InstalledTreeSnapshot(Identity, directoryIdentities, fileSnapshots, paths.Directories, paths.Files);
    }

    private string Physical(string relative) => relative.Length == 0 ? canonicalRoot : Path.Combine(canonicalRoot, relative.Replace('/', Path.DirectorySeparatorChar));
    public void Dispose() { foreach (FileStream file in files.Values) file.Dispose(); files.Clear(); foreach (SafeFileHandle directory in directories.Values) directory.Dispose(); directories.Clear(); ancestorChain.Dispose(); }
}

internal sealed class InstallPinnedTree : IDisposable
{
    private readonly Dictionary<string, SafeFileHandle> directories = new(StringComparer.OrdinalIgnoreCase); private readonly Dictionary<string, FileStream> files = new(StringComparer.OrdinalIgnoreCase); private readonly InstallAncestorChain chain; private readonly Action? beforeCleanupAttempt; private string canonicalRoot; private bool published; private bool cleanupUnsafe;
    private InstallPinnedTree(string root, SafeFileHandle handle, InstallAncestorChain chain, Action? beforeCleanupAttempt) { Root = root; canonicalRoot = InstallNative.Canonical(handle); this.chain = chain; this.beforeCleanupAttempt = beforeCleanupAttempt; directories.Add(string.Empty, handle); }
    internal string Root { get; private set; } internal string PublishSourcePath => Root; internal InstalledFileIdentity Identity => InstallNative.Identity(directories[string.Empty]);
    internal InstalledFileIdentity RootIdentity => Identity;
    internal string CurrentRootHandleFinalPath => InstallNative.Canonical(directories[string.Empty]);
    internal bool TryResolvePinnedRootPathWithin(string allowedRoot, out string path)
    {
        path = string.Empty;
        try
        {
            using SafeFileHandle allowedHandle = InstallNative.OpenDirectory(allowedRoot, InstallNative.ReadAttributes, FileShare.ReadWrite | FileShare.Delete);
            InstallNative.ValidateDirectory(allowedHandle, allowedRoot);
            string allowed = InstallNative.Canonical(allowedHandle);
            string actual = CurrentRootHandleFinalPath;
            if (!InstallNative.IsStrictlyContained(allowed, actual)) return false;
            path = actual;
            return true;
        }
        catch (PreparedArtifactInstallationException) { return false; }
    }
    internal static InstallPinnedTree CreatePartial(string root, InstallAncestorChain chain, Action? beforeCleanupAttempt)
    {
        chain.Validate();
        SafeFileHandle handle = InstallNative.OpenDirectory(root, InstallNative.ReadAttributes | InstallNative.Delete, FileShare.ReadWrite | FileShare.Delete);
        try { InstallNative.ValidateDirectory(handle, root); if (!string.Equals(Path.GetDirectoryName(InstallNative.Canonical(handle)), chain.CanonicalContainer, StringComparison.OrdinalIgnoreCase)) throw new PreparedArtifactInstallationException("Install root escaped container."); return new InstallPinnedTree(root, handle, chain, beforeCleanupAttempt); } catch { handle.Dispose(); throw; }
    }
    internal void EnsureDirectories(IReadOnlyList<string> segments) { string relative = string.Empty; foreach (string segment in segments) { relative = relative.Length == 0 ? segment : relative + "/" + segment; if (directories.ContainsKey(relative)) continue; string path = Physical(relative); if (!InstallNative.CreateDirectoryW(path, IntPtr.Zero) && Marshal.GetLastWin32Error() != 183) throw new PreparedArtifactInstallationException("Destination directory create failed."); SafeFileHandle handle = InstallNative.OpenDirectory(path, InstallNative.ReadAttributes | InstallNative.Delete, FileShare.Read | FileShare.Delete); try { InstallNative.ValidateDirectory(handle, path); directories.Add(relative, handle); } catch { handle.Dispose(); throw; } } }
    internal FileStream CreateFile(string relative) { string path = Physical(relative); SafeFileHandle handle = InstallNative.CreateFileW(path, InstallNative.GenericRead | InstallNative.GenericWrite | InstallNative.Delete, FileShare.Read | FileShare.Delete, IntPtr.Zero, FileMode.CreateNew, InstallNative.Normal | InstallNative.OpenReparse | InstallNative.WriteThrough, IntPtr.Zero); if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new PreparedArtifactInstallationException("Destination CREATE_NEW failed.", new Win32Exception(error)); } try { InstallNative.ValidateFile(handle, path); var stream = new FileStream(handle, FileAccess.ReadWrite, 131_072, false); files.Add(relative, stream); return stream; } catch { handle.Dispose(); throw; } }
    internal Stream OpenRead(string relative) { if (!files.TryGetValue(relative, out FileStream? file)) throw new PreparedArtifactInstallationException("Destination file is not pinned: " + relative); InstallNative.ValidateFile(file.SafeFileHandle, Physical(relative)); if (!InstallNative.DuplicateHandle(InstallNative.GetCurrentProcess(), file.SafeFileHandle, InstallNative.GetCurrentProcess(), out SafeFileHandle duplicate, InstallNative.GenericRead, false, 0)) throw new PreparedArtifactInstallationException("DuplicateHandle failed."); var result = new FileStream(duplicate, FileAccess.Read); result.Position = 0; return result; }
    internal void ValidateFile(string relative) => InstallNative.ValidateFile(files[relative].SafeFileHandle, Physical(relative));
    internal TreePaths EnumerateAndPin() { PinAll(); return new TreePaths(files.Keys.ToHashSet(StringComparer.OrdinalIgnoreCase), directories.Keys.Where(static value => value.Length != 0).ToHashSet(StringComparer.OrdinalIgnoreCase)); }
    internal TreePaths EnumerateAndPinAt(string actualRoot)
    {
        SafeFileHandle candidate = InstallNative.OpenDirectory(actualRoot, InstallNative.ReadAttributes | InstallNative.Delete, FileShare.ReadWrite | FileShare.Delete);
        try
        {
            InstallNative.ValidateDirectory(candidate, actualRoot);
            if (InstallNative.Identity(candidate) != RootIdentity) throw new PreparedArtifactInstallationException("Resolved cleanup root identity differs from pinned root.");
        }
        finally { candidate.Dispose(); }
        Root = InstallNative.Normalize(actualRoot);
        canonicalRoot = Root;
        return EnumerateAndPin();
    }
    internal void ValidateAll() { chain.Validate(); ValidatePinnedAll(); }
    internal void ValidatePinnedAll() { foreach (KeyValuePair<string, SafeFileHandle> item in directories) InstallNative.ValidateDirectory(item.Value, Physical(item.Key)); foreach (KeyValuePair<string, FileStream> item in files) InstallNative.ValidateFile(item.Value.SafeFileHandle, Physical(item.Key)); }
    private void PinAll() { foreach (string path in Directory.EnumerateFileSystemEntries(Root, "*", SearchOption.AllDirectories).OrderBy(static value => value.Length)) { string relative = Path.GetRelativePath(Root, path).Replace('\\', '/'); FileAttributes attributes = File.GetAttributes(path); if ((attributes & FileAttributes.ReparsePoint) != 0) throw new PreparedArtifactInstallationException("Reparse point in destination."); if ((attributes & FileAttributes.Directory) != 0) { if (!directories.ContainsKey(relative)) { SafeFileHandle handle = InstallNative.OpenDirectory(path, InstallNative.ReadAttributes | InstallNative.Delete, FileShare.Read | FileShare.Delete); try { InstallNative.ValidateDirectory(handle, path); directories.Add(relative, handle); } catch { handle.Dispose(); throw; } } } else if (!files.ContainsKey(relative)) { uint access = InstallNative.GenericRead | InstallNative.Delete; SafeFileHandle handle = InstallNative.CreateFileW(path, access, FileShare.Read | FileShare.Delete, IntPtr.Zero, FileMode.Open, InstallNative.OpenReparse, IntPtr.Zero); if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new PreparedArtifactInstallationException("Existing file pin failed.", new Win32Exception(error)); } try { InstallNative.ValidateFile(handle, path); files.Add(relative, new FileStream(handle, FileAccess.Read)); } catch { handle.Dispose(); throw; } } } }
    internal InstalledTreeSnapshot CaptureSnapshotAndDetachForPublish()
    {
        ValidateAll();
        TreePaths exact = EnumerateAndPin();
        ValidateAll();
        var directoryIdentities = directories.ToDictionary(static item => item.Key, static item => InstallNative.Identity(item.Value), StringComparer.OrdinalIgnoreCase);
        var fileSnapshots = new Dictionary<string, PinnedFileSnapshot>(StringComparer.OrdinalIgnoreCase);
        foreach (KeyValuePair<string, FileStream> item in files)
        {
            item.Value.Position = 0;
            fileSnapshots.Add(item.Key, new PinnedFileSnapshot(InstallNative.Identity(item.Value.SafeFileHandle), item.Value.Length, SHA256.HashData(item.Value)));
            item.Value.Position = 0;
        }
        InstalledTreeSnapshot snapshot = new(Identity, directoryIdentities, fileSnapshots, exact.Directories, exact.Files);
        DisposeHandles();
        cleanupUnsafe = true; // DetachedForPublish: path cleanup is forbidden until a failed move is safely re-pinned.
        return snapshot;
    }

    internal void ReopenPartialAfterFailedMove(InstalledTreeSnapshot snapshot, int moveError)
    {
        SafeFileHandle? root = TryOpenValidatedRoot(PublishSourcePath);
        if (root is null) throw FailClosedMove(moveError, "partial root cannot be reopened");
        directories.Add(string.Empty, root);
        canonicalRoot = InstallNative.Canonical(root);
        try
        {
            PinAll();
            TreePaths actual = new(files.Keys.ToHashSet(StringComparer.OrdinalIgnoreCase), directories.Keys.Where(static value => value.Length != 0).ToHashSet(StringComparer.OrdinalIgnoreCase));
            if (!actual.Files.SetEquals(snapshot.ExactFiles) || !actual.Directories.SetEquals(snapshot.ExactDirectories) || Identity != snapshot.RootIdentity) throw new PreparedArtifactInstallationException("Partial tree changed after failed publish.");
            foreach (KeyValuePair<string, InstalledFileIdentity> item in snapshot.Directories) if (!directories.TryGetValue(item.Key, out SafeFileHandle? handle) || InstallNative.Identity(handle) != item.Value) throw new PreparedArtifactInstallationException("Partial directory identity changed after failed publish: " + item.Key);
            foreach (KeyValuePair<string, PinnedFileSnapshot> item in snapshot.Files)
            {
                if (!files.TryGetValue(item.Key, out FileStream? file) || InstallNative.Identity(file.SafeFileHandle) != item.Value.Identity) throw new PreparedArtifactInstallationException("Partial file identity changed after failed publish: " + item.Key);
                file.Position = 0;
                if (file.Length != item.Value.Length || !CryptographicOperations.FixedTimeEquals(SHA256.HashData(file), item.Value.Sha256)) throw new PreparedArtifactInstallationException("Partial file content changed after failed publish: " + item.Key);
                file.Position = 0;
            }
            cleanupUnsafe = false;
        }
        catch (Exception exception)
        {
            cleanupUnsafe = true;
            Debug.WriteLine("SECURITY CLEANUP TICKET: failed move left an untrusted partial; preserving it: " + exception);
            throw new PreparedArtifactInstallationException("Move failed and partial snapshot comparison failed; refusing cleanup.", exception);
        }
    }

    internal void MarkPublished() { published = true; cleanupUnsafe = true; }
    private static PreparedArtifactInstallationException FailClosedMove(int error, string detail) => new("MoveFileExW failed and " + detail + "; unknown objects are preserved.", new Win32Exception(error));
    internal void Cleanup() { if (published) return; if (cleanupUnsafe) { DisposeHandles(); return; } beforeCleanupAttempt?.Invoke(); if (!directories.ContainsKey(string.Empty)) throw new PreparedArtifactInstallationException("Cleanup cannot safely identify the original partial root; refusing path-based deletion."); foreach (string key in files.Keys.OrderByDescending(static value => value.Count(static c => c == '/')).ToArray()) { InstallNative.DeleteByHandle(files[key].SafeFileHandle); files[key].Dispose(); files.Remove(key); } foreach (string key in directories.Keys.OrderByDescending(static value => value.Length == 0 ? -1 : value.Count(static c => c == '/') + 1).ToArray()) { InstallNative.DeleteByHandle(directories[key]); directories[key].Dispose(); directories.Remove(key); } }
    private static SafeFileHandle? TryOpenValidatedRoot(string path)
    {
        SafeFileHandle handle;
        try { handle = InstallNative.OpenDirectory(path, InstallNative.ReadAttributes | InstallNative.Delete, FileShare.ReadWrite | FileShare.Delete); }
        catch (PreparedArtifactInstallationException) { return null; }
        try { InstallNative.ValidateDirectory(handle, path); return handle; } catch (PreparedArtifactInstallationException) { handle.Dispose(); return null; }
    }
    internal void AbandonCleanup() { cleanupUnsafe = true; DisposeHandles(); }
    private void DisposeHandles() { foreach (FileStream file in files.Values) file.Dispose(); files.Clear(); foreach (SafeFileHandle directory in directories.Values) directory.Dispose(); directories.Clear(); }
    private string Physical(string relative) => relative.Length == 0 ? canonicalRoot : Path.Combine(canonicalRoot, relative.Replace('/', Path.DirectorySeparatorChar));
    public void Dispose() { if (published) DisposeHandles(); else Cleanup(); }
}

internal static class InstallNative
{
    internal const uint GenericRead = 0x80000000, GenericWrite = 0x40000000, Delete = 0x00010000, ReadAttributes = 0x00000080, FileAddFile = 0x00000002, FileAddSubdirectory = 0x00000004, FileDeleteChild = 0x00000040, Normal = 0x80, WriteThrough = 0x80000000, Backup = 0x02000000, OpenReparse = 0x00200000, MoveFileWriteThrough = 0x00000008;
    internal static SafeFileHandle OpenDirectory(string path, uint access, FileShare share) { SafeFileHandle handle = CreateFileW(path, access, share, IntPtr.Zero, FileMode.Open, Backup | OpenReparse, IntPtr.Zero); if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new PreparedArtifactInstallationException("Directory pin failed.", new Win32Exception(error)); } return handle; }
    internal static void ValidateDirectory(SafeFileHandle handle, string expected) { Info info = GetInfo(handle); FileAttributes attr = (FileAttributes)info.Attributes; if ((attr & FileAttributes.Directory) == 0 || (attr & FileAttributes.ReparsePoint) != 0 || info.Links != 1) throw new PreparedArtifactInstallationException("Directory is not regular single-link nonreparse."); RequireCanonical(handle, expected); }
    internal static void ValidateFile(SafeFileHandle handle, string expected) { Info info = GetInfo(handle); FileAttributes attr = (FileAttributes)info.Attributes; if ((attr & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 || info.Links != 1) throw new PreparedArtifactInstallationException("File is not regular single-link nonreparse."); RequireCanonical(handle, expected); }
    internal static InstalledFileIdentity Identity(SafeFileHandle handle) { Info info = GetInfo(handle); return new InstalledFileIdentity(info.Volume, ((ulong)info.IndexHigh << 32) | info.IndexLow); }
    internal static string Canonical(SafeFileHandle handle) { var buffer = new StringBuilder(512); uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0); if (length == 0) throw new PreparedArtifactInstallationException("Canonical query failed.", new Win32Exception(Marshal.GetLastWin32Error())); if (length >= buffer.Capacity) { buffer.EnsureCapacity(checked((int)length + 1)); length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0); } return Normalize(buffer.ToString()); }
    internal static string Normalize(string value) { if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) value = @"\\" + value[8..]; else if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) value = value[4..]; string full = Path.GetFullPath(value); string root = Path.GetPathRoot(full) ?? full; return string.Equals(full, root, StringComparison.OrdinalIgnoreCase) ? root : Path.TrimEndingDirectorySeparator(full); }
    internal static bool IsStrictlyContained(string root, string path) { string normalizedRoot = Normalize(root); string normalizedPath = Normalize(path); return normalizedPath.StartsWith(Path.TrimEndingDirectorySeparator(normalizedRoot) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase); }
    internal static void DeleteByHandle(SafeFileHandle handle) { var value = new Disposition { DeleteFile = true }; if (!SetFileInformationByHandle(handle, Class.Disposition, ref value, (uint)Marshal.SizeOf<Disposition>())) throw new PreparedArtifactInstallationException("Handle cleanup failed.", new Win32Exception(Marshal.GetLastWin32Error())); }
    internal static bool Move(string source, string destination) => MoveFileExW(source, destination, MoveFileWriteThrough);
    internal static bool MoveReplace(string source, string destination) => MoveFileExW(source, destination, MoveFileWriteThrough | 0x00000001);
    private static Info GetInfo(SafeFileHandle handle) { if (!GetFileInformationByHandle(handle, out Info info)) throw new PreparedArtifactInstallationException("Identity query failed."); return info; }
    private static void RequireCanonical(SafeFileHandle handle, string expected) { if (!string.Equals(Canonical(handle), Normalize(expected), StringComparison.OrdinalIgnoreCase)) throw new PreparedArtifactInstallationException("Canonical path escaped or changed."); }
    private enum Class { Disposition = 4 }
    [StructLayout(LayoutKind.Sequential)] private struct Disposition { [MarshalAs(UnmanagedType.Bool)] internal bool DeleteFile; }
    [StructLayout(LayoutKind.Sequential)] private struct Info { internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation; internal System.Runtime.InteropServices.ComTypes.FILETIME Access; internal System.Runtime.InteropServices.ComTypes.FILETIME Write; internal uint Volume; internal uint SizeHigh; internal uint SizeLow; internal uint Links; internal uint IndexHigh; internal uint IndexLow; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)] internal static extern SafeFileHandle CreateFileW(string name, uint access, FileShare share, IntPtr security, FileMode mode, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreateDirectoryW(string name, IntPtr security);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out Info info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetFileInformationByHandle(SafeFileHandle file, Class kind, ref Disposition info, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool MoveFileExW(string existingName, string newName, uint flags);
    [DllImport("kernel32.dll")] internal static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool DuplicateHandle(IntPtr sourceProcess, SafeFileHandle source, IntPtr targetProcess, out SafeFileHandle target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
}
