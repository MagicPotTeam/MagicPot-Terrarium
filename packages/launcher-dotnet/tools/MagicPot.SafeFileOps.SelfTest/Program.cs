using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using MagicPot.SafeFileOps;
using Microsoft.Win32.SafeHandles;

internal static class Program
{
    private static int Main()
    {
        if (!OperatingSystem.IsWindows()) { Console.WriteLine("Windows only"); return 0; }
        string sandbox = Path.Combine(Path.GetTempPath(), "SafeFileOps-" + Guid.NewGuid().ToString("N"));
        string root = Path.Combine(sandbox, "root");
        Directory.CreateDirectory(root);
        try
        {
            NestedInspectDelete(root);
            IdentityMismatch(root);
            OutsideRoot(root);
            HardLink(root);
            TargetReparse(root);
            IntermediateReparse(root);
            CaseSensitiveDirectory(sandbox);
            PinnedRenameGuards(sandbox, root);
            HookExceptionPreservesSentinel(sandbox, root);
            Race(root);
            Console.WriteLine("MagicPot.SafeFileOps self-test passed");
            return 0;
        }
        finally
        {
            SafeFileOpsCore.BeforeTargetOpen = null;
            SafeFileOpsCore.BeforeDisposition = null;
            if (Directory.Exists(sandbox)) Directory.Delete(sandbox, true);
        }
    }

    private static SafeDeleteRequest Request(string root, string path) { var id = SafeFileOpsCore.GetIdentity(path); return new(root, path, id.VolumeSerial, id.FileIndex); }
    private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

    private static void NestedInspectDelete(string root)
    {
        string parent = Path.Combine(root, "nested", "two", "three");
        Directory.CreateDirectory(parent);
        string path = Path.Combine(parent, "ordinary");
        File.WriteAllText(path, "x");
        SafeInspectResult inspect = SafeFileOpsCore.InspectFile(new(root, path));
        Require(inspect.Status == "inspected", "nested inspect failed");
        SafeDeleteResult delete = SafeFileOpsCore.DeleteFile(new(root, path, inspect.VolumeSerial, inspect.FileIndex));
        Require(delete.Status == "deleted" && !File.Exists(path), "nested delete failed");
    }

    private static void IdentityMismatch(string root)
    {
        string path = Path.Combine(root, "foreign");
        File.WriteAllText(path, "x");
        SafeDeleteRequest request = Request(root, path);
        SafeDeleteResult result = SafeFileOpsCore.DeleteFile(request with { FileIndex = request.FileIndex + 1 });
        Require(result.Status == "foreign-preserved" && File.Exists(path), "identity mismatch deleted");
        File.Delete(path);
    }

    private static void OutsideRoot(string root)
    {
        string path = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        File.WriteAllText(path, "outside");
        try
        {
            SafeInspectResult inspect = SafeFileOpsCore.InspectFile(new(root, path));
            SafeDeleteResult delete = SafeFileOpsCore.DeleteFile(Request(root, path));
            Require(inspect.Status == "foreign-preserved" && delete.Status == "foreign-preserved" && File.Exists(path), "outside file accepted");
        }
        finally { File.Delete(path); }
    }

    private static void HardLink(string root)
    {
        string outside = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        string link = Path.Combine(root, "hardlink");
        File.WriteAllText(outside, "target");
        try
        {
            if (!CreateHardLinkW(link, outside, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            SafeDeleteResult result = SafeFileOpsCore.DeleteFile(Request(root, link));
            Require(result.Status == "deleted" && !File.Exists(link) && File.ReadAllText(outside) == "target", "hardlink target changed");
        }
        finally { if (File.Exists(link)) File.Delete(link); File.Delete(outside); }
    }

    private static void TargetReparse(string root)
    {
        string target = Path.Combine(root, "target");
        string link = Path.Combine(root, "symlink");
        File.WriteAllText(target, "sentinel");
        try
        {
            File.CreateSymbolicLink(link, target);
            SafeDeleteResult result = SafeFileOpsCore.DeleteFile(Request(root, link));
            Require(result.Status == "foreign-preserved" && File.ReadAllText(target) == "sentinel", "target reparse followed");
        }
        catch (UnauthorizedAccessException) { }
        finally { if (File.Exists(link)) File.Delete(link); File.Delete(target); }
    }

    private static void IntermediateReparse(string root)
    {
        string outside = Path.Combine(Path.GetTempPath(), "SafeFileOps-outside-" + Guid.NewGuid().ToString("N"));
        string sentinel = Path.Combine(outside, "sentinel");
        Directory.CreateDirectory(outside);
        File.WriteAllText(sentinel, "keep");
        foreach (bool junction in new[] { false, true })
        {
            string link = Path.Combine(root, junction ? "junction-parent" : "symlink-parent");
            try
            {
                if (junction) CreateJunction(link, outside); else Directory.CreateSymbolicLink(link, outside);
                string throughLink = Path.Combine(link, "sentinel");
                SafeInspectResult inspect = SafeFileOpsCore.InspectFile(new(root, throughLink));
                SafeDeleteResult delete = SafeFileOpsCore.DeleteFile(Request(root, throughLink));
                Require(inspect.Status == "foreign-preserved" && delete.Status == "foreign-preserved" && File.ReadAllText(sentinel) == "keep", "intermediate reparse followed");
            }
            catch (UnauthorizedAccessException) when (!junction) { }
            finally { if (Directory.Exists(link)) Directory.Delete(link); }
        }
        Directory.Delete(outside, true);
    }

    private static void CaseSensitiveDirectory(string sandbox)
    {
        string caseSandbox = Path.Combine(sandbox, "case-sensitive");
        string owned = Path.Combine(caseSandbox, "Owned");
        string foreign = Path.Combine(caseSandbox, "owned");
        Directory.CreateDirectory(caseSandbox);
        bool parentEnabled = false;
        bool ownedEnabled = false;
        try
        {
            parentEnabled = TrySetCaseSensitive(caseSandbox, true);
            if (!parentEnabled)
            {
                Console.WriteLine("Case-sensitive directory self-test skipped (unsupported filesystem or insufficient privilege)");
                return;
            }

            Directory.CreateDirectory(owned);
            ownedEnabled = TrySetCaseSensitive(owned, true);
            if (!ownedEnabled)
            {
                Console.WriteLine("Case-sensitive directory self-test skipped (unable to mark test root)");
                return;
            }

            Directory.CreateDirectory(foreign);
            string outside = Path.Combine(foreign, "file");
            File.WriteAllText(outside, "keep");
            SafeInspectResult inspect = SafeFileOpsCore.InspectFile(new(owned, outside));
            SafeDeleteResult delete = SafeFileOpsCore.DeleteFile(Request(owned, outside));
            Require(inspect.Status == "foreign-preserved" && delete.Status == "foreign-preserved" && File.ReadAllText(outside) == "keep", "case-sensitive sibling accepted or deleted");
        }
        finally
        {
            if (Directory.Exists(foreign)) Directory.Delete(foreign, true);
            if (ownedEnabled && Directory.Exists(owned) && !TrySetCaseSensitive(owned, false)) throw new InvalidOperationException("failed to restore test root case-insensitivity");
            if (Directory.Exists(owned)) Directory.Delete(owned, true);
            if (parentEnabled && Directory.Exists(caseSandbox) && !TrySetCaseSensitive(caseSandbox, false)) throw new InvalidOperationException("failed to restore test parent case-insensitivity");
            if (Directory.Exists(caseSandbox)) Directory.Delete(caseSandbox, true);
        }
    }

    private static bool TrySetCaseSensitive(string path, bool enabled)
    {
        const uint writeAttributes = 0x100;
        const uint shareAll = 7;
        const uint openExisting = 3;
        const uint backupSemantics = 0x02000000;
        using SafeFileHandle handle = CreateFileW(path, writeAttributes, shareAll, IntPtr.Zero, openExisting, backupSemantics, IntPtr.Zero);
        if (handle.IsInvalid) return false;
        FileCaseSensitiveInformation info = new() { Flags = enabled ? 1u : 0u };
        return SetFileInformationByHandle(handle, 23, ref info, (uint)Marshal.SizeOf<FileCaseSensitiveInformation>());
    }

    private static void PinnedRenameGuards(string sandbox, string root)
    {
        string intermediate = Path.Combine(root, "pin", "middle");
        Directory.CreateDirectory(intermediate);
        string inspectTarget = Path.Combine(intermediate, "inspect");
        File.WriteAllText(inspectTarget, "owned");
        string rootMoved = Path.Combine(sandbox, "root-moved");
        string rootReplacement = Path.Combine(sandbox, "root-replacement");
        SafeFileOpsCore.BeforeTargetOpen = () => AttemptMoveAndReplacement(root, rootMoved, rootReplacement, "root rename was not denied");
        SafeInspectResult inspect = SafeFileOpsCore.InspectFile(new(root, inspectTarget));
        SafeFileOpsCore.BeforeTargetOpen = null;
        Require(inspect.Status == "inspected" && Directory.Exists(root) && !Directory.Exists(rootMoved), "inspect root pin failed");

        string deleteTarget = Path.Combine(intermediate, "delete");
        File.WriteAllText(deleteTarget, "owned");
        string middleMoved = intermediate + ".moved";
        string middleReplacement = intermediate + ".replacement";
        string outsideSentinel = Path.Combine(sandbox, "outside-sentinel");
        File.WriteAllText(outsideSentinel, "keep");
        SafeFileOpsCore.BeforeDisposition = () => AttemptMoveAndReplacement(intermediate, middleMoved, middleReplacement, "intermediate rename was not denied");
        SafeDeleteResult delete = SafeFileOpsCore.DeleteFile(Request(root, deleteTarget));
        SafeFileOpsCore.BeforeDisposition = null;
        Require(delete.Status == "deleted" && !File.Exists(deleteTarget), "delete with pinned intermediate failed");
        Require(File.ReadAllText(outsideSentinel) == "keep", "external sentinel deleted after caught hook exception");
        File.Delete(outsideSentinel);
        File.Delete(inspectTarget);
    }

    private static void HookExceptionPreservesSentinel(string sandbox, string root)
    {
        string path = Path.Combine(root, "hook-exception");
        string sentinel = Path.Combine(sandbox, "hook-sentinel");
        File.WriteAllText(path, "owned");
        File.WriteAllText(sentinel, "keep");
        SafeFileOpsCore.BeforeDisposition = () => throw new InvalidOperationException("injected hook failure");
        try
        {
            _ = SafeFileOpsCore.DeleteFile(Request(root, path));
            throw new InvalidOperationException("hook exception was swallowed");
        }
        catch (InvalidOperationException exception) when (exception.Message == "injected hook failure") { }
        finally { SafeFileOpsCore.BeforeDisposition = null; }
        Require(File.Exists(path) && File.ReadAllText(sentinel) == "keep", "hook exception deleted a sentinel");
        File.Delete(path);
        File.Delete(sentinel);
    }

    private static void AttemptMoveAndReplacement(string original, string moved, string replacement, string message)
    {
        Directory.CreateDirectory(replacement);
        File.WriteAllText(Path.Combine(replacement, "sentinel"), "keep");
        try
        {
            RequireSharingDenied(() => Directory.Move(original, moved), message);
            Require(Directory.Exists(original) && !Directory.Exists(moved), message);
        }
        finally
        {
            Require(File.ReadAllText(Path.Combine(replacement, "sentinel")) == "keep", "replacement sentinel changed");
            Directory.Delete(replacement, true);
        }
    }

    private static void RequireSharingDenied(Action move, string message)
    {
        try { move(); }
        catch (IOException exception) when ((exception.HResult & 0xffff) is 5 or 32) { return; }
        throw new InvalidOperationException(message);
    }

    private static void Race(string root)
    {
        for (int i = 0; i < 100; i++)
        {
            string path = Path.Combine(root, "race-" + i);
            string moved = path + ".moved";
            File.WriteAllText(path, "owned");
            SafeDeleteRequest request = Request(root, path);
            SafeFileOpsCore.BeforeDisposition = () => { File.Move(path, moved); File.WriteAllText(path, "sentinel"); };
            SafeDeleteResult result = SafeFileOpsCore.DeleteFile(request);
            SafeFileOpsCore.BeforeDisposition = null;
            Require(result.Status == "deleted-foreign-preserved", "race status");
            Require(File.ReadAllText(path) == "sentinel", "replacement deleted");
            Require(!File.Exists(moved), "opened original not deleted");
            File.Delete(path);
        }
    }

    private static void CreateJunction(string link, string target)
    {
        using System.Diagnostics.Process process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("cmd.exe", $"/d /c mklink /J \"{link}\" \"{target}\"") { CreateNoWindow = true, UseShellExecute = false })!;
        process.WaitForExit();
        if (process.ExitCode != 0) throw new InvalidOperationException("junction unavailable");
    }

    [StructLayout(LayoutKind.Sequential)] private struct FileCaseSensitiveInformation { public uint Flags; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateHardLinkW(string newName, string existingName, IntPtr security);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, ref FileCaseSensitiveInformation info, uint size);
}
