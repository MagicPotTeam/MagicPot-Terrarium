using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace MagicPot.SafeFileOps;

public sealed record SafeInspectRequest(string Root, string Path);
public sealed record SafeInspectResult(int ExitCode, string Status, uint VolumeSerial, ulong FileIndex);
public sealed record SafeDeleteRequest(string Root, string Path, uint VolumeSerial, ulong FileIndex);
public sealed record SafeDeleteResult(int ExitCode, string Status);
public sealed class SafeFileOpsException : Exception
{
    public SafeFileOpsException(string message) : base(message) { }
    public SafeFileOpsException(string message, Exception innerException) : base(message, innerException) { }
}

public static class SafeFileOpsCore
{
    private const uint Delete = 0x00010000;
    private const uint ReadAttributes = 0x80;
    private const uint ShareAll = 7;
    private const uint DirectoryShare = (uint)(FileShare.Read | FileShare.Write);
    private const uint OpenExisting = 3;
    private const uint OpenReparse = 0x00200000;
    private const uint BackupSemantics = 0x02000000;
    private const uint AttributeDirectory = 0x10;
    private const uint AttributeReparse = 0x400;
    private const int FileCaseSensitiveInfo = 23;
    private const uint FileCsFlagCaseSensitiveDir = 1;
    internal static Action? BeforeTargetOpen { get; set; }
    internal static Action? BeforeDisposition { get; set; }

    public sealed class PinnedDirectoryChain : IDisposable
    {
        private readonly List<SafeFileHandle> handles = new();
        private readonly List<PinnedDirectory> directories = new();

        public PinnedDirectoryChain(string root, string targetParent)
        {
            RootPath = Normalize(root);
            ParentPath = Normalize(targetParent);

            try
            {
                foreach (string expected in EnumerateDirectories(ParentPath))
                {
                    SafeFileHandle handle = CreateFileW(expected, ReadAttributes, DirectoryShare, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparse, IntPtr.Zero);
                    if (handle.IsInvalid)
                    {
                        int error = Marshal.GetLastWin32Error();
                        handle.Dispose();
                        throw new Win32Exception(error);
                    }
                    handles.Add(handle);
                    if (!GetFileInformationByHandle(handle, out FileInformation info)) throw Error();
                    if ((info.FileAttributes & AttributeDirectory) == 0 || (info.FileAttributes & AttributeReparse) != 0 || info.NumberOfLinks < 1) throw new UnsafePathException();
                    if (!GetFileInformationByHandleEx(handle, FileCaseSensitiveInfo, out FileCaseSensitiveInformation caseInfo, (uint)Marshal.SizeOf<FileCaseSensitiveInformation>()))
                        throw new SafeFileOpsException("Unable to verify directory case-sensitivity; refusing the operation.", Error());
                    if ((caseInfo.Flags & FileCsFlagCaseSensitiveDir) != 0 || (caseInfo.Flags & ~FileCsFlagCaseSensitiveDir) != 0)
                        throw new SafeFileOpsException("Case-sensitive directories are not supported by SafeFileOps.");

                    string final = Normalize(FinalPath(handle));
                    directories.Add(new(expected, final, info.VolumeSerialNumber, caseInfo.Flags));
                }

                // OrdinalIgnoreCase comparisons are valid only after every pinned directory is verified case-insensitive.
                if (!IsSameOrDescendant(RootPath, ParentPath)) throw new UnsafePathException();
                bool sawRoot = false;
                foreach (PinnedDirectory directory in directories)
                {
                    if (!PathEquals(directory.FinalPath, directory.ExpectedPath)) throw new UnsafePathException();
                    if (PathEquals(directory.ExpectedPath, RootPath))
                    {
                        sawRoot = true;
                        RootFinal = directory.FinalPath;
                        VolumeSerial = directory.VolumeSerial;
                    }
                    else if (sawRoot && directory.VolumeSerial != VolumeSerial)
                    {
                        throw new UnsafePathException();
                    }
                    if (PathEquals(directory.ExpectedPath, ParentPath)) ParentFinal = directory.FinalPath;
                }

                if (!sawRoot || RootFinal is null || ParentFinal is null || !IsSameOrDescendant(RootFinal, ParentFinal) || !ContainsCaseInsensitiveParent(ParentFinal)) throw new UnsafePathException();
            }
            catch
            {
                Dispose();
                throw;
            }
        }

        public string RootPath { get; }
        public string ParentPath { get; }
        public string RootFinal { get; private set; } = null!;
        public string ParentFinal { get; private set; } = null!;
        public uint VolumeSerial { get; private set; }

        public bool ContainsCaseInsensitiveParent(string path) =>
            directories.Exists(directory => directory.CaseSensitiveFlags == 0 && PathEquals(directory.FinalPath, path) && PathEquals(directory.ExpectedPath, ParentPath));

        public void Dispose()
        {
            for (int i = handles.Count - 1; i >= 0; i--) handles[i].Dispose();
            handles.Clear();
            directories.Clear();
        }

        private sealed record PinnedDirectory(string ExpectedPath, string FinalPath, uint VolumeSerial, uint CaseSensitiveFlags);
    }

    public static SafeInspectResult InspectFile(SafeInspectRequest request)
    {
        if (!OperatingSystem.IsWindows()) return new(2, "system-error", 0, 0);
        string root = Normalize(request.Root);
        string path = Normalize(request.Path);
        string? parent = Path.GetDirectoryName(path);
        if (parent is null) return new(4, "foreign-preserved", 0, 0);

        try
        {
            using PinnedDirectoryChain chain = new(root, parent);
            BeforeTargetOpen?.Invoke();
            using SafeFileHandle fileHandle = CreateFileW(path, ReadAttributes, ShareAll, IntPtr.Zero, OpenExisting, OpenReparse, IntPtr.Zero);
            if (fileHandle.IsInvalid || !GetFileInformationByHandle(fileHandle, out FileInformation info)) throw Error();
            if (!IsSafeTarget(chain, fileHandle, info)) return new(4, "foreign-preserved", 0, 0);
            return new(0, "inspected", info.VolumeSerialNumber, FileIndex(info));
        }
        catch (Exception exception) when (exception is UnsafePathException or SafeFileOpsException)
        {
            return new(4, "foreign-preserved", 0, 0);
        }
    }

    public static SafeDeleteResult DeleteFile(SafeDeleteRequest request)
    {
        if (!OperatingSystem.IsWindows()) return new(2, "system-error");
        string root = Normalize(request.Root);
        string path = Normalize(request.Path);
        string? parent = Path.GetDirectoryName(path);
        if (parent is null) return new(4, "foreign-preserved");

        try
        {
            using PinnedDirectoryChain chain = new(root, parent);
            if (chain.VolumeSerial != request.VolumeSerial) return new(3, "identity-mismatch");
            BeforeTargetOpen?.Invoke();
            using SafeFileHandle fileHandle = CreateFileW(path, Delete | ReadAttributes, ShareAll, IntPtr.Zero, OpenExisting, OpenReparse, IntPtr.Zero);
            if (fileHandle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                if (error is 2 or 3) return new(3, "identity-mismatch");
                throw new Win32Exception(error);
            }
            if (!GetFileInformationByHandle(fileHandle, out FileInformation info)) throw Error();
            ulong index = FileIndex(info);
            if (!IsSafeTarget(chain, fileHandle, info) || info.VolumeSerialNumber != request.VolumeSerial || index != request.FileIndex) return new(4, "foreign-preserved");

            BeforeDisposition?.Invoke();
            FileDispositionInfo disposition = new() { DeleteFile = true };
            if (!SetFileInformationByHandle(fileHandle, 4, ref disposition, (uint)Marshal.SizeOf<FileDispositionInfo>())) throw Error();
            fileHandle.Dispose();

            using SafeFileHandle after = CreateFileW(path, ReadAttributes, ShareAll, IntPtr.Zero, OpenExisting, OpenReparse, IntPtr.Zero);
            if (after.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                if (error is 2 or 3) return new(0, "deleted");
                throw new Win32Exception(error);
            }
            if (!GetFileInformationByHandle(after, out FileInformation afterInfo)) throw Error();
            return afterInfo.VolumeSerialNumber == request.VolumeSerial && FileIndex(afterInfo) == request.FileIndex
                ? new(2, "delete-not-observed")
                : new(0, "deleted-foreign-preserved");
        }
        catch (Exception exception) when (exception is UnsafePathException or SafeFileOpsException)
        {
            return new(4, "foreign-preserved");
        }
    }

    internal static (uint VolumeSerial, ulong FileIndex) GetIdentity(string path)
    {
        using SafeFileHandle handle = CreateFileW(path, ReadAttributes, ShareAll, IntPtr.Zero, OpenExisting, OpenReparse, IntPtr.Zero);
        if (handle.IsInvalid || !GetFileInformationByHandle(handle, out FileInformation info)) throw Error();
        return (info.VolumeSerialNumber, FileIndex(info));
    }

    private static bool IsSafeTarget(PinnedDirectoryChain chain, SafeFileHandle handle, FileInformation info)
    {
        if ((info.FileAttributes & (AttributeDirectory | AttributeReparse)) != 0 || info.NumberOfLinks < 1 || info.VolumeSerialNumber != chain.VolumeSerial) return false;
        string final = Normalize(FinalPath(handle));
        string? finalParent = Path.GetDirectoryName(final);
        return finalParent is not null && chain.ContainsCaseInsensitiveParent(finalParent) && PathEquals(finalParent, chain.ParentFinal) && IsDescendant(chain.RootFinal, final);
    }

    private static IEnumerable<string> EnumerateDirectories(string path)
    {
        string? pathRoot = Path.GetPathRoot(path);
        if (string.IsNullOrEmpty(pathRoot)) throw new UnsafePathException();
        string current = Normalize(pathRoot);
        yield return current;
        string relative = Path.GetRelativePath(current, path);
        if (relative == ".") yield break;
        foreach (string segment in relative.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Normalize(Path.Combine(current, segment));
            yield return current;
        }
    }

    private static string Normalize(string path)
    {
        string full = Path.GetFullPath(path);
        string? root = Path.GetPathRoot(full);
        return root is not null && string.Equals(full, root, StringComparison.OrdinalIgnoreCase) ? full : Path.TrimEndingDirectorySeparator(full);
    }
    private static ulong FileIndex(FileInformation info) => ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow;
    private static bool IsDescendant(string root, string path) => IsSameOrDescendant(root, path) && !PathEquals(root, path);
    private static bool IsSameOrDescendant(string root, string path) => PathEquals(root, path) || path.StartsWith(Normalize(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    private static bool PathEquals(string left, string right) => string.Equals(Normalize(left), Normalize(right), StringComparison.OrdinalIgnoreCase);
    private static string FinalPath(SafeFileHandle handle) { StringBuilder buffer = new(32768); uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0); if (length == 0 || length >= buffer.Capacity) throw Error(); string value = buffer.ToString(); return value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase) ? @"\\" + value[8..] : value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase) ? value[4..] : value; }
    private static Win32Exception Error() => new(Marshal.GetLastWin32Error());
    private sealed class UnsafePathException : Exception { }
    [StructLayout(LayoutKind.Sequential)] private struct FileTime { public uint Low; public uint High; }
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation { public uint FileAttributes; public FileTime CreationTime; public FileTime LastAccessTime; public FileTime LastWriteTime; public uint VolumeSerialNumber; public uint FileSizeHigh; public uint FileSizeLow; public uint NumberOfLinks; public uint FileIndexHigh; public uint FileIndexLow; }
    [StructLayout(LayoutKind.Sequential)] private struct FileDispositionInfo { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }
    [StructLayout(LayoutKind.Sequential)] private struct FileCaseSensitiveInformation { public uint Flags; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, out FileCaseSensitiveInformation info, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, ref FileDispositionInfo info, uint size);
}
