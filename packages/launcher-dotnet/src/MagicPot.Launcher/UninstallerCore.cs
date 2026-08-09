using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace MagicPot.Launcher;

internal interface IUninstallProcessBackend { int CurrentProcessId { get; } string CurrentExe { get; } void StartDetached(string exe, IReadOnlyList<string> arguments); bool WaitForExit(int processId, TimeSpan timeout); }
internal interface ITempSelfCleanup { bool Schedule(string path); }
internal sealed record UninstallerRequest(string Root, string InstallId, int Phase, int? ParentProcessId, bool Quiet);
internal enum UninstallerResult { Completed, Handoff }
internal sealed class UninstallerCore
{
    private readonly IUninstallProcessBackend processes; private readonly ITempSelfCleanup cleanup; private readonly Func<string, string, UninstallCapability> buildCapability; private readonly Func<IInstallIntegration> integration;
    internal UninstallerCore(IUninstallProcessBackend processes, ITempSelfCleanup cleanup, Func<string, string, UninstallCapability> buildCapability, Func<IInstallIntegration> integration) { this.processes = processes; this.cleanup = cleanup; this.buildCapability = buildCapability; this.integration = integration; }
    internal UninstallerResult Run(UninstallerRequest request)
    {
        string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(request.Root)); BootstrapOwnershipV1 ownership = BootstrapInstallerCore.ReadOwnership(Path.Combine(root, BootstrapInstallerCore.OwnershipFileName)) ?? throw new BootstrapInstallerException("Ownership is missing.");
        if (ownership.InstallId != request.InstallId || !ownership.Root.Equals(root, StringComparison.OrdinalIgnoreCase)) throw new BootstrapInstallerException("Uninstall ownership mismatch.");
        if (request.Phase == 1 && Below(processes.CurrentExe, root))
        {
            string temporary = Path.Combine(Path.GetTempPath(), "MagicPot-Uninstall-" + ownership.OperationId + ".exe"); CopyVerified(processes.CurrentExe, temporary); processes.StartDetached(temporary, ["--phase2", "--parent-pid", processes.CurrentProcessId.ToString(), "--install-id", request.InstallId, "--root", root, request.Quiet ? "--quiet" : "--interactive"]); return UninstallerResult.Handoff;
        }
        if (request.Phase != 2) throw new BootstrapInstallerException("Phase 2 is required outside the install root.");
        if (request.ParentProcessId is int parent && !processes.WaitForExit(parent, TimeSpan.FromSeconds(30))) throw new BootstrapInstallerException("MagicPot is still running; close it and retry.");
        using UninstallCapability capability = buildCapability(root, request.InstallId); capability.ValidateStillOwned(); integration().Rollback(ownership.OperationId, ownership, Path.Combine(root, "Launcher", "MagicPot.Launcher.exe")); capability.ExecuteDeleteOwnedTree(); _ = cleanup.Schedule(processes.CurrentExe); return UninstallerResult.Completed;
    }
    private static void CopyVerified(string source, string destination) { byte[] hash; long size; using (FileStream input = new(source, FileMode.Open, FileAccess.Read, FileShare.Read)) { size = input.Length; hash = SHA256.HashData(input); input.Position = 0; using FileStream output = new(destination, FileMode.Create, FileAccess.Write, FileShare.None); input.CopyTo(output); output.Flush(true); } using FileStream check = new(destination, FileMode.Open, FileAccess.Read, FileShare.Read); if (check.Length != size || !CryptographicOperations.FixedTimeEquals(SHA256.HashData(check), hash)) { File.Delete(destination); throw new BootstrapInstallerException("Uninstaller handoff copy verification failed."); } }
    private static bool Below(string path, string root) { string full = Path.GetFullPath(path); return full.Equals(root, StringComparison.OrdinalIgnoreCase) || full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase); }
}
internal sealed class WindowsUninstallProcessBackend : IUninstallProcessBackend
{
    public int CurrentProcessId => Environment.ProcessId; public string CurrentExe => Environment.ProcessPath ?? throw new BootstrapInstallerException("Current executable path is unavailable.");
    public void StartDetached(string exe, IReadOnlyList<string> arguments) { var start = new ProcessStartInfo(exe) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(exe)! }; foreach (string argument in arguments) start.ArgumentList.Add(argument); _ = Process.Start(start) ?? throw new BootstrapInstallerException("Uninstaller handoff failed."); }
    public bool WaitForExit(int processId, TimeSpan timeout) { try { using Process process = Process.GetProcessById(processId); return process.WaitForExit((int)timeout.TotalMilliseconds); } catch (ArgumentException) { return true; } }
}
internal sealed class MoveFileExTempSelfCleanup : ITempSelfCleanup
{
    public bool Schedule(string path) => MoveFileEx(path, null, 4); [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool MoveFileEx(string existing, string? replacement, int flags);
}
