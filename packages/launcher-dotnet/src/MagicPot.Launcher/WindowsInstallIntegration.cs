using Microsoft.Win32;

namespace MagicPot.Launcher;

internal sealed record RegistrySnapshot(bool Exists, IReadOnlyDictionary<string, string> Values);
internal sealed record ShellLinkSnapshot(string Target, string Arguments, string WorkingDirectory, string IconPath);
internal interface IRegistryBackend { RegistrySnapshot Read(string keyPath); void SetValues(string keyPath, IReadOnlyDictionary<string, string> values); void DeleteKey(string keyPath); }
internal interface IShellLinkBackend { ShellLinkSnapshot? Read(string path); void WriteTemporary(string path, ShellLinkSnapshot value); void AtomicReplace(string temporaryPath, string path); void Delete(string path); }
internal interface IFileBackend { string StartMenuPrograms { get; } string Desktop { get; } void CreateDirectory(string path); }

internal sealed class WindowsInstallIntegration : IInstallIntegration
{
    internal const string ProductId = "MagicPot-Terrarium";
    private readonly IRegistryBackend registry; private readonly IShellLinkBackend links; private readonly IFileBackend files; private readonly bool desktopShortcut;
    internal WindowsInstallIntegration(IRegistryBackend registry, IShellLinkBackend links, IFileBackend files, bool desktopShortcut = false) { this.registry = registry; this.links = links; this.files = files; this.desktopShortcut = desktopShortcut; }
    internal static WindowsInstallIntegration CreateDefault(bool desktopShortcut = false) => new(new CurrentUserRegistryBackend(), new ComShellLinkBackend(), new WindowsIntegrationFileBackend(), desktopShortcut);
    internal string RegistryKey(BootstrapOwnershipV1 ownership) => $@"Software\Microsoft\Windows\CurrentVersion\Uninstall\{ProductId}-{ShortId(ownership.InstallId)}";
    internal string StartMenuLink(BootstrapOwnershipV1 ownership) => Path.Combine(files.StartMenuPrograms, "MagicPot", $"MagicPot-{ShortId(ownership.InstallId)}.lnk");
    internal string? DesktopLink(BootstrapOwnershipV1 ownership) => desktopShortcut ? Path.Combine(files.Desktop, $"MagicPot-{ShortId(ownership.InstallId)}.lnk") : null;
    public InstallIntegrationState Inspect(string operationId, BootstrapOwnershipV1 ownership)
    {
        Expected expected = Build(operationId, ownership); var states = new List<int> { Compare(registry.Read(expected.Key), expected.Registry), Compare(links.Read(expected.StartMenuPath), expected.Link) };
        if (expected.DesktopPath is not null) states.Add(Compare(links.Read(expected.DesktopPath), expected.Link));
        if (states.Contains(2)) return InstallIntegrationState.Conflict; return states.All(static state => state == 1) ? InstallIntegrationState.Applied : InstallIntegrationState.Missing;
    }
    public void Apply(string operationId, BootstrapOwnershipV1 ownership, string launcherExe)
    {
        Expected expected = Build(operationId, ownership, launcherExe); if (Inspect(operationId, ownership) == InstallIntegrationState.Conflict) throw new BootstrapInstallerException("Install integration conflicts with an existing current-user entry.");
        WriteLinkIfMissing(expected.StartMenuPath, expected.Link, operationId); if (expected.DesktopPath is not null) WriteLinkIfMissing(expected.DesktopPath, expected.Link, operationId);
        RegistrySnapshot current = registry.Read(expected.Key); if (!current.Exists) registry.SetValues(expected.Key, expected.Registry); else if (Compare(current, expected.Registry) != 1) throw new BootstrapInstallerException("Uninstall registry entry changed during apply."); Verify(operationId, ownership, launcherExe);
    }
    public void Verify(string operationId, BootstrapOwnershipV1 ownership, string launcherExe) { if (Inspect(operationId, ownership) != InstallIntegrationState.Applied) throw new BootstrapInstallerException("Install integration exact verification failed."); }
    public void Rollback(string operationId, BootstrapOwnershipV1 ownership, string launcherExe)
    {
        Expected expected = Build(operationId, ownership, launcherExe); RegistrySnapshot current = registry.Read(expected.Key); if (Owned(current, operationId, ownership.InstallId)) registry.DeleteKey(expected.Key); DeleteLinkIfOwned(expected.StartMenuPath, expected.Link); if (expected.DesktopPath is not null) DeleteLinkIfOwned(expected.DesktopPath, expected.Link);
    }
    private void WriteLinkIfMissing(string path, ShellLinkSnapshot value, string operationId) { ShellLinkSnapshot? current = links.Read(path); if (current is not null) { if (current != value) throw new BootstrapInstallerException("Shortcut changed during apply."); return; } files.CreateDirectory(Path.GetDirectoryName(path)!); string temporary = path + "." + operationId + ".partial"; links.WriteTemporary(temporary, value); links.AtomicReplace(temporary, path); }
    private void DeleteLinkIfOwned(string path, ShellLinkSnapshot expected) { if (links.Read(path) == expected) links.Delete(path); }
    private Expected Build(string operationId, BootstrapOwnershipV1 ownership, string? launcherExe = null)
    {
        launcherExe ??= Path.Combine(ownership.Root, "Launcher", "MagicPot.Launcher.exe"); string uninstall = Path.Combine(ownership.Root, "Launcher", "MagicPot.Uninstall.exe"); string arguments = $"--install-id {Quote(ownership.InstallId)} --root {Quote(ownership.Root)}"; var link = new ShellLinkSnapshot(launcherExe, "--launch", ownership.Root, launcherExe);
        var values = new Dictionary<string, string>(StringComparer.Ordinal) { ["DisplayName"] = "MagicPot Terrarium", ["InstallLocation"] = ownership.Root, ["DisplayIcon"] = launcherExe, ["UninstallString"] = $"{Quote(uninstall)} {arguments}", ["QuietUninstallString"] = $"{Quote(uninstall)} {arguments} --quiet", ["OperationId"] = operationId, ["InstallId"] = ownership.InstallId, ["DisplayVersion"] = ownership.LauncherVersion };
        return new(RegistryKey(ownership), values, StartMenuLink(ownership), DesktopLink(ownership), link);
    }
    private static int Compare(RegistrySnapshot actual, IReadOnlyDictionary<string, string> expected) { if (!actual.Exists) return 0; return expected.Count == actual.Values.Count && expected.All(pair => actual.Values.TryGetValue(pair.Key, out string? value) && value == pair.Value) ? 1 : 2; }
    private static int Compare(ShellLinkSnapshot? actual, ShellLinkSnapshot expected) => actual is null ? 0 : actual == expected ? 1 : 2;
    private static bool Owned(RegistrySnapshot snapshot, string operationId, string installId) => snapshot.Exists && snapshot.Values.TryGetValue("OperationId", out string? op) && op == operationId && snapshot.Values.TryGetValue("InstallId", out string? id) && id == installId;
    private static string ShortId(string value) => value[..Math.Min(8, value.Length)]; private static string Quote(string value) => '"' + value.Replace("\"", "\\\"") + '"';
    private sealed record Expected(string Key, IReadOnlyDictionary<string, string> Registry, string StartMenuPath, string? DesktopPath, ShellLinkSnapshot Link);
}
internal sealed class CurrentUserRegistryBackend : IRegistryBackend
{
    public RegistrySnapshot Read(string keyPath) { using RegistryKey? key = Registry.CurrentUser.OpenSubKey(keyPath, false); if (key is null) return new(false, new Dictionary<string, string>()); return new(true, key.GetValueNames().ToDictionary(static name => name, name => key.GetValue(name)?.ToString() ?? string.Empty, StringComparer.Ordinal)); }
    public void SetValues(string keyPath, IReadOnlyDictionary<string, string> values) { using RegistryKey key = Registry.CurrentUser.CreateSubKey(keyPath, true); foreach ((string name, string value) in values) key.SetValue(name, value, RegistryValueKind.String); }
    public void DeleteKey(string keyPath) => Registry.CurrentUser.DeleteSubKeyTree(keyPath, false);
}
internal sealed class WindowsIntegrationFileBackend : IFileBackend
{
    public string StartMenuPrograms => Environment.GetFolderPath(Environment.SpecialFolder.Programs);
    public string Desktop => Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
    public void CreateDirectory(string path) => Directory.CreateDirectory(path);
}

internal sealed class ComShellLinkBackend : IShellLinkBackend
{
    public ShellLinkSnapshot? Read(string path) { if (!File.Exists(path)) return null; Type type = Type.GetTypeFromProgID("WScript.Shell") ?? throw new PlatformNotSupportedException("WScript.Shell is unavailable."); object shell = Activator.CreateInstance(type)!; dynamic shortcut = type.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, [path])!; return new((string)shortcut.TargetPath, (string)shortcut.Arguments, (string)shortcut.WorkingDirectory, ((string)shortcut.IconLocation).Split(',')[0]); }
    public void WriteTemporary(string path, ShellLinkSnapshot value) { Type type = Type.GetTypeFromProgID("WScript.Shell") ?? throw new PlatformNotSupportedException("WScript.Shell is unavailable."); object shell = Activator.CreateInstance(type)!; dynamic shortcut = type.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, [path])!; shortcut.TargetPath = value.Target; shortcut.Arguments = value.Arguments; shortcut.WorkingDirectory = value.WorkingDirectory; shortcut.IconLocation = value.IconPath; shortcut.Save(); }
    public void AtomicReplace(string temporaryPath, string path) => File.Move(temporaryPath, path, false); public void Delete(string path) => File.Delete(path);
}
