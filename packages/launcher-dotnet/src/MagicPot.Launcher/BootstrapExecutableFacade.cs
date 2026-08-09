using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace MagicPot.Launcher;

public static class BootstrapExecutableFacade
{
    private const int MaxDescriptorBytes = 4 * 1024 * 1024;
    private const int SignatureBytes = 64;

    public static async Task<string> InstallAsync(
        string descriptorPath,
        string signaturePath,
        string? installRoot = null,
        string? legacySourceLabel = null,
        CancellationToken cancellationToken = default)
    {
        descriptorPath = RequireAbsolute(descriptorPath, nameof(descriptorPath));
        signaturePath = RequireAbsolute(signaturePath, nameof(signaturePath));
        if (string.Equals(InstallNative.Normalize(descriptorPath), InstallNative.Normalize(signaturePath), StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Descriptor and signature paths must be different.");
        if (legacySourceLabel is not null && (legacySourceLabel.Length is < 1 or > 256 || legacySourceLabel.Any(static c => c < ' '))) throw new ArgumentException("legacySourceLabel must be a bounded informational string.", nameof(legacySourceLabel));

        string root = installRoot is null
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MagicPot")
            : RequireAbsolute(installRoot, nameof(installRoot));

        byte[] descriptor = ReadSecureBytes(descriptorPath, MaxDescriptorBytes, exactLength: null, "descriptor");
        byte[] signature = ReadSecureBytes(signaturePath, SignatureBytes, SignatureBytes, "signature");
        string descriptorDirectory = Path.GetDirectoryName(descriptorPath) ?? throw new ArgumentException("Descriptor path has no parent directory.", nameof(descriptorPath));
        using VerifiedBootstrapBundle bundle = VerifiedBootstrapBundle.VerifyBootstrapDescriptor(descriptor, signature, descriptorDirectory);
        using var downloader = new ArtifactDownloader(new ArtifactDownloadOptions { StateRoot = root });
        var preparer = new ArtifactPreparer(new ArtifactPreparationOptions { StateRoot = root });
        var installer = new PreparedArtifactInstaller(new PreparedArtifactInstallerOptions { Root = root });
        var core = new BootstrapInstallerCore(new BootstrapInstallerOptions
        {
            AbsoluteInstallRoot = root,
            Integration = WindowsInstallIntegration.CreateDefault(),
            LegacyDetector = legacySourceLabel is null ? null : new InformationalLegacySourceDetector(legacySourceLabel),
            ArtifactDownloader = downloader.DownloadAsync,
            ArtifactPreparer = preparer.PrepareAsync,
            ArtifactInstaller = installer.InstallAsync
        });
        BootstrapOwnershipV1 ownership = await core.InstallOrRecoverAsync(bundle, cancellationToken).ConfigureAwait(false);
        return ownership.Root;
    }

    private static byte[] ReadSecureBytes(string path, int maximumLength, int? exactLength, string label)
    {
        SafeFileHandle handle = InstallNative.CreateFileW(path, InstallNative.GenericRead, FileShare.None, IntPtr.Zero, FileMode.Open, InstallNative.OpenReparse | InstallNative.Normal, IntPtr.Zero);
        if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new IOException($"Bootstrap {label} open failed.", new Win32Exception(error)); }
        using var stream = new FileStream(handle, FileAccess.Read, 4096, false);
        InstallNative.ValidateFile(handle, path);
        long length = stream.Length;
        if (length <= 0 || length > maximumLength || exactLength is int required && length != required) throw new IOException($"Bootstrap {label} size is invalid.");
        byte[] bytes = new byte[checked((int)length)];
        stream.ReadExactly(bytes);
        if (stream.Position != length || stream.Length != length) throw new IOException($"Bootstrap {label} changed while being read.");
        InstallNative.ValidateFile(handle, path);
        return bytes;
    }

    private static string RequireAbsolute(string path, string name)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path)) throw new ArgumentException(name + " must be absolute.", name);
        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
    }

    private sealed class InformationalLegacySourceDetector : ILegacyInstallationDetector
    {
        private readonly string label;
        internal InformationalLegacySourceDetector(string label) => this.label = label;
        public LegacyInstallation? Detect() => new(label, null);
    }
}
