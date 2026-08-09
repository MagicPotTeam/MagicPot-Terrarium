using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace MagicPot.Launcher;

internal sealed record LauncherUpdateConfiguration(bool Enabled, string LauncherVersion, IReadOnlyDictionary<string, string> ChannelUrls, IReadOnlyList<TrustedReleaseSource> TrustedSources, IReadOnlyDictionary<string, byte[]> PublicKeys, string? KeySetIdentity = null)
{
    internal static LauncherUpdateConfiguration Disabled { get; } = new(false, "0.0.0", new Dictionary<string, string>(StringComparer.Ordinal) { ["stable"] = string.Empty, ["beta"] = string.Empty, ["nightly"] = string.Empty }, OfflineUpdateDecision.DefaultTrustedReleaseSources, new Dictionary<string, byte[]>(StringComparer.Ordinal));
}


public sealed record UpdateLaunchResult(string Mode, string Status, string Channel, string? Version = null)
{
    public static UpdateLaunchResult Manual(LauncherSettingsV1 settings) => new(settings.UpdateMode, "manual", settings.Channel);
}

internal sealed record UpdateCheckOutcome(
    LauncherSettingsV1 Settings,
    UpdateLaunchResult Status,
    VerifiedChannelManifestProof? Proof = null,
    SelectedArtifactsV1? Candidate = null,
    ChannelManifestLoadResult? Load = null);

internal interface IChannelManifestClient : IDisposable
{
    Task<ChannelManifestLoadResult> LoadAsync(CancellationToken cancellationToken = default);
}

internal interface IChannelManifestClientFactory
{
    IChannelManifestClient Create(ChannelManifestClientOptions options);
}

internal sealed class DefaultChannelManifestClientFactory : IChannelManifestClientFactory
{
    public IChannelManifestClient Create(ChannelManifestClientOptions options) => new ChannelManifestClient(options);
}

public static class LauncherSettingsStore
{
    public static LauncherSettingsV1 Default { get; } = new(1, "manual", "stable", 3, 3, false);

    public static LauncherSettingsV1 Read(string root)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        var fullRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        var settingsPath = Path.Combine(fullRoot, "settings.json");
        ValidateDirectory(fullRoot);
        if (!File.Exists(settingsPath)) return Default;
        ValidateFile(settingsPath, fullRoot);
        using var handle = File.OpenHandle(settingsPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, FileOptions.None);
        ValidateHandle(handle, settingsPath);
        using var stream = new FileStream(handle, FileAccess.Read);
        using var reader = new StreamReader(stream, new UTF8Encoding(false, true), detectEncodingFromByteOrderMarks: false);
        var text = reader.ReadToEnd();
        ValidateHandle(stream.SafeFileHandle, settingsPath);
        ValidateFile(settingsPath, fullRoot);
        return OfflineUpdateDecision.ParseLauncherSettings(text);
    }

    private static void ValidateDirectory(string path)
    {
        var info = new DirectoryInfo(path);
        if (!info.Exists || info.LinkTarget is not null || (info.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Launcher root is missing or redirected");
    }

    private static void ValidateFile(string path, string root)
    {
        if (!string.Equals(Path.GetDirectoryName(path), root, StringComparison.OrdinalIgnoreCase) || !string.Equals(Path.GetFileName(path), "settings.json", StringComparison.Ordinal)) throw new IOException("Settings path is not the fixed launcher-root child");
        var info = new FileInfo(path);
        if (!info.Exists || info.LinkTarget is not null || (info.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) throw new IOException("settings.json is not a regular file");
    }

    private static void ValidateHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle, string expectedPath)
    {
        if (!OperatingSystem.IsWindows()) return;
        var buffer = new StringBuilder(32768);
        var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0 || length >= buffer.Capacity) throw new IOException("settings.json handle path could not be resolved");
        var actual = buffer.ToString();
        if (actual.StartsWith("\\\\?\\", StringComparison.Ordinal)) actual = actual[4..];
        if (!string.Equals(Path.GetFullPath(actual), Path.GetFullPath(expectedPath), StringComparison.OrdinalIgnoreCase)) throw new IOException("settings.json handle does not identify the fixed path");
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern uint GetFinalPathNameByHandleW(Microsoft.Win32.SafeHandles.SafeFileHandle file, StringBuilder filePath, uint filePathLength, uint flags);
}

internal static partial class LauncherUpdateCheck
{
    public static async Task<UpdateCheckOutcome> RunFromSettingsAsync(LauncherLayout layout, ValidatedInstallation active, LauncherUpdateConfiguration configuration, IChannelManifestClientFactory factory, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(layout);
        ArgumentNullException.ThrowIfNull(active);
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(factory);
        try
        {
            var settings = LauncherSettingsStore.Read(layout.Root);
            return await RunAsync(layout, active, settings, configuration, factory, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is OfflineUpdateException or IOException or UnauthorizedAccessException or ArgumentException or DecoderFallbackException)
        {
            return new(LauncherSettingsStore.Default, new(LauncherSettingsStore.Default.UpdateMode, "failed", LauncherSettingsStore.Default.Channel));
        }
    }

    public static async Task<UpdateCheckOutcome> RunAsync(LauncherLayout layout, ValidatedInstallation active, LauncherSettingsV1 settings, LauncherUpdateConfiguration configuration, IChannelManifestClientFactory factory, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(layout); ArgumentNullException.ThrowIfNull(active); ArgumentNullException.ThrowIfNull(settings); ArgumentNullException.ThrowIfNull(configuration); ArgumentNullException.ThrowIfNull(factory);
        if (settings.UpdateMode == "manual") return new(settings, UpdateLaunchResult.Manual(settings));
        if (!configuration.Enabled) return new(settings, new(settings.UpdateMode, "disabled", settings.Channel));
        if (!configuration.ChannelUrls.TryGetValue(settings.Channel, out var url) || string.IsNullOrWhiteSpace(url)) return new(settings, new(settings.UpdateMode, "failed", settings.Channel));
        try
        {
            var options = new ChannelManifestClientOptions
            {
                Url = url, Channel = settings.Channel, StateRoot = Path.Combine(layout.Root, "manifest-state", settings.Channel),
                SignatureVerifier = new Ed25519ChannelManifestSignatureVerifier(configuration.PublicKeys), TrustedSources = configuration.TrustedSources
            };
            using var client = factory.Create(options);
            var loaded = await client.LoadAsync(cancellationToken).ConfigureAwait(false);
            var candidate = OfflineUpdateDecision.SelectLatestArtifactsWithPolicy(loaded.Proof.Manifest, settings, configuration.LauncherVersion);
            if (candidate is null) return new(settings, new(settings.UpdateMode, "unavailable", settings.Channel), loaded.Proof, null, loaded);
            var comparison = OfflineUpdateDecision.CompareSemanticVersions(candidate.Release.Version, active.App.Version);
            if (comparison is null) return new(settings, new(settings.UpdateMode, "failed", settings.Channel), loaded.Proof, candidate, loaded);
            if (comparison <= 0) return new(settings, new(settings.UpdateMode, "up-to-date", settings.Channel), loaded.Proof, candidate, loaded);
            return new(settings, new(settings.UpdateMode, "available", settings.Channel, candidate.Release.Version), loaded.Proof, candidate, loaded);
        }
        catch (ChannelManifestClientException exception)
        {
            return new(settings, new(settings.UpdateMode, exception.FailureKind == ChannelManifestFailureKind.Unavailable ? "unavailable" : "failed", settings.Channel));
        }
        catch (Exception exception) when (exception is OfflineUpdateException or IOException or UnauthorizedAccessException or ArgumentException) { return new(settings, new(settings.UpdateMode, "failed", settings.Channel)); }
    }

    public static bool IsEnvironmentVersion(string? value) => value is not null && EnvironmentVersionRegex().IsMatch(value);
    [GeneratedRegex("^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$")]
    private static partial Regex EnvironmentVersionRegex();
}
