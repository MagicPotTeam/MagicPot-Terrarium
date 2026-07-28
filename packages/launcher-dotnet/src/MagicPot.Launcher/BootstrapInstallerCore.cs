using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

namespace MagicPot.Launcher;

internal sealed class BootstrapTrustConfiguration
{
    private readonly IReadOnlyDictionary<string, byte[]> descriptorKeys;
    private readonly IReadOnlyDictionary<string, byte[]> manifestKeys;

    private BootstrapTrustConfiguration() : this(false, new Dictionary<string, byte[]>(), new Dictionary<string, byte[]>()) { }
    private BootstrapTrustConfiguration(bool enabled, IReadOnlyDictionary<string, byte[]> descriptorKeys, IReadOnlyDictionary<string, byte[]> manifestKeys)
    {
        Enabled = enabled;
        this.descriptorKeys = CopyKeys(descriptorKeys);
        this.manifestKeys = CopyKeys(manifestKeys);
        ManifestVerifier = enabled ? new Ed25519ChannelManifestSignatureVerifier(this.manifestKeys) : new ProductionFailClosedSignatureVerifier();
        Identity = enabled ? "bootstrap-trust-v1:" + HashKeys(this.descriptorKeys, this.manifestKeys) : "bootstrap-trust-disabled:v1";
    }

    internal static BootstrapTrustConfiguration Disabled { get; } = new();
    internal static BootstrapTrustConfiguration CreateCompiled(bool enabled, IReadOnlyDictionary<string, byte[]> descriptorKeys, IReadOnlyDictionary<string, byte[]> manifestKeys) => new(enabled, descriptorKeys, manifestKeys);
    internal bool Enabled { get; }
    internal string Identity { get; }
    internal IChannelManifestSignatureVerifier ManifestVerifier { get; }
    internal bool TryGetDescriptorKey(string keyId, out byte[] key)
    {
        if (!Enabled || !descriptorKeys.TryGetValue(keyId, out byte[]? configured)) { key = []; return false; }
        key = (byte[])configured.Clone(); return true;
    }

    private static IReadOnlyDictionary<string, byte[]> CopyKeys(IReadOnlyDictionary<string, byte[]> source)
    {
        ArgumentNullException.ThrowIfNull(source); var result = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        foreach ((string id, byte[] value) in source)
        {
            if (string.IsNullOrWhiteSpace(id) || value is null || value.Length != 32) throw new ArgumentException("Bootstrap trust keys require a non-empty id and a 32-byte Ed25519 key.");
            result.Add(id, (byte[])value.Clone());
        }
        return result;
    }

    private static string HashKeys(params IReadOnlyDictionary<string, byte[]>[] sets)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (IReadOnlyDictionary<string, byte[]> set in sets)
            foreach ((string id, byte[] key) in set.OrderBy(static x => x.Key, StringComparer.Ordinal))
            {
                byte[] name = Encoding.UTF8.GetBytes(id); hash.AppendData(BitConverter.GetBytes(name.Length)); hash.AppendData(name); hash.AppendData(key);
            }
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }
}

internal sealed record BootstrapSignatureV1(string Algorithm, string KeyId);
internal sealed record BootstrapArtifactV1(string SourcePath, string Sha256, long Size);
internal sealed record BootstrapSelectionV1(string Channel, string BuildId, string RuntimeId);
internal sealed record BootstrapStableBinaryV1(string Version, string SourcePath, long Size, string Sha256);
internal sealed record BootstrapDescriptorV1(int Schema, BootstrapSignatureV1 Signature, string LauncherVersion, BootstrapArtifactV1 Launcher, BootstrapStableBinaryV1 Uninstaller, string ChannelManifestRaw, BootstrapSelectionV1 Selection);
internal sealed record BootstrapOwnershipV1(int Schema, string OperationId, string InstallId, string Root, string LauncherSha256, long LauncherSize, string LauncherVersion, string UninstallerSha256, long UninstallerSize, string UninstallerVersion, string ActiveBuildId, string ActiveRuntimeId, string CreatedAt, string? LegacySource);
internal sealed record BootstrapInstallJournalV1(int Schema, string Stage, string OperationId, string InstallId, string DescriptorIdentity, string LauncherSha256, long LauncherSize, string LauncherVersion, string UninstallerSha256, long UninstallerSize, string UninstallerVersion, string ActiveBuildId, string ActiveRuntimeId, string CreatedAt, string? LegacySource, string LauncherTemporaryName, string UninstallerTemporaryName);
internal sealed record BootstrapArtifactInstallResult(string AppDirectory, string RuntimeDirectory);
internal sealed record LegacyInstallation(string Path, string? Version);
internal enum InstallIntegrationState { Missing, Applied, Conflict }
internal interface IInstallIntegration
{
    InstallIntegrationState Inspect(string operationId, BootstrapOwnershipV1 ownership);
    void Apply(string operationId, BootstrapOwnershipV1 ownership, string launcherExe);
    void Verify(string operationId, BootstrapOwnershipV1 ownership, string launcherExe);
    void Rollback(string operationId, BootstrapOwnershipV1 ownership, string launcherExe);
}
internal interface ILegacyInstallationDetector { LegacyInstallation? Detect(); }
internal sealed class BootstrapInstallerException : Exception { internal BootstrapInstallerException(string message) : base(message) { } internal BootstrapInstallerException(string message, Exception inner) : base(message, inner) { } }

internal sealed class VerifiedStablePayloadLease : IDisposable
{
    private FileStream? stream;
    internal VerifiedStablePayloadLease(FileStream stream, long size, string sha256) { this.stream = stream; Size = size; Sha256 = sha256; Identity = InstallNative.Identity(stream.SafeFileHandle); }
    internal long Size { get; }
    internal string Sha256 { get; }
    internal InstalledFileIdentity Identity { get; }
    internal FileStream Stream => stream ?? throw new ObjectDisposedException(nameof(VerifiedStablePayloadLease));
    public void Dispose() { stream?.Dispose(); stream = null; }
}

internal sealed class VerifiedBootstrapBundle : IDisposable
{
    private VerifiedBootstrapBundle(BootstrapDescriptorV1 descriptor, VerifiedChannelManifestProof proof, SelectedArtifactsV1 selection, string configurationIdentity, string descriptorIdentity, VerifiedStablePayloadLease launcherPayload, VerifiedStablePayloadLease uninstallerPayload)
    { Descriptor = descriptor; ChannelProof = proof; Selection = selection; ConfigurationIdentity = configurationIdentity; DescriptorIdentity = descriptorIdentity; LauncherPayload = launcherPayload; UninstallerPayload = uninstallerPayload; (AppRequest, RuntimeRequest) = proof.CreateRequests(selection); }
    internal BootstrapDescriptorV1 Descriptor { get; }
    internal VerifiedChannelManifestProof ChannelProof { get; }
    internal SelectedArtifactsV1 Selection { get; }
    internal VerifiedArtifactRequest AppRequest { get; }
    internal VerifiedArtifactRequest RuntimeRequest { get; }
    internal string ConfigurationIdentity { get; }
    internal string DescriptorIdentity { get; }
    internal VerifiedStablePayloadLease LauncherPayload { get; }
    internal VerifiedStablePayloadLease UninstallerPayload { get; }

    public void Dispose() { LauncherPayload.Dispose(); UninstallerPayload.Dispose(); }

    internal static VerifiedBootstrapBundle VerifyBootstrapDescriptor(ReadOnlySpan<byte> descriptorBytes, ReadOnlySpan<byte> signature, string descriptorDirectory)
    {
        BootstrapTrustConfiguration configuration = CompiledBootstrapTrustConfiguration.Create();
        if (!configuration.Enabled) throw new BootstrapInstallerException("Bootstrap trust is disabled.");
        if (descriptorBytes.Length is <= 0 or > 4 * 1024 * 1024) throw new BootstrapInstallerException("Bootstrap descriptor size is invalid.");
        if (signature.Length != 64) throw new BootstrapInstallerException("Invalid Ed25519 signature length.");
        if (!Path.IsPathFullyQualified(descriptorDirectory)) throw new BootstrapInstallerException("Descriptor directory must be absolute.");
        byte[] bytes = descriptorBytes.ToArray(); BootstrapDescriptorV1 descriptor = Parse(bytes);
        if (!string.Equals(descriptor.Signature.Algorithm, "ed25519", StringComparison.Ordinal) || !configuration.TryGetDescriptorKey(descriptor.Signature.KeyId, out byte[] publicKey)) throw new BootstrapInstallerException("Bootstrap descriptor key is disabled or unknown.");
        var verifier = new Ed25519Signer(); verifier.Init(false, new Ed25519PublicKeyParameters(publicKey, 0)); verifier.BlockUpdate(bytes, 0, bytes.Length);
        if (!verifier.VerifySignature(signature.ToArray())) throw new BootstrapInstallerException("Bootstrap descriptor signature is invalid.");
        VerifiedChannelManifestProof proof = OfflineUpdateDecision.ParseAndVerifyChannelManifest(descriptor.ChannelManifestRaw, descriptor.Selection.Channel, configuration.ManifestVerifier);
        if (!string.Equals(proof.VerifierIdentity, configuration.ManifestVerifier.VerifierIdentity, StringComparison.Ordinal)) throw new BootstrapInstallerException("Manifest proof did not originate from the configured update verifier.");
        SelectedArtifactsV1 selection = proof.Manifest.Releases.Where(r => r.BuildId == descriptor.Selection.BuildId && r.Artifacts.Runtime?.RuntimeId == descriptor.Selection.RuntimeId && r.Artifacts.App.RuntimeId == descriptor.Selection.RuntimeId).Select(r => new SelectedArtifactsV1(r, r.Artifacts.App, r.Artifacts.Runtime!)).SingleOrDefault() ?? throw new BootstrapInstallerException("Selection is not uniquely bound to the signed channel manifest.");
        string directory = Path.TrimEndingDirectorySeparator(Path.GetFullPath(descriptorDirectory));
        string launcherPath = ResolvePayload(directory, descriptor.Launcher.SourcePath);
        string uninstallerPath = ResolvePayload(directory, descriptor.Uninstaller.SourcePath);
        if (string.Equals(InstallNative.Normalize(launcherPath), InstallNative.Normalize(uninstallerPath), StringComparison.OrdinalIgnoreCase)) throw new BootstrapInstallerException("Stable payload paths must be different.");
        VerifiedStablePayloadLease? launcherPayload = null;
        try
        {
            launcherPayload = OpenPayload(launcherPath, descriptor.Launcher.Size, descriptor.Launcher.Sha256, "Launcher");
            VerifiedStablePayloadLease uninstallerPayload = OpenPayload(uninstallerPath, descriptor.Uninstaller.Size, descriptor.Uninstaller.Sha256, "Uninstaller");
            if (launcherPayload.Identity == uninstallerPayload.Identity) { uninstallerPayload.Dispose(); throw new BootstrapInstallerException("Stable payload handles must identify different files."); }
            return new(descriptor, proof, selection, configuration.Identity, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), launcherPayload, uninstallerPayload);
        }
        catch { launcherPayload?.Dispose(); throw; }
    }

    private static string ResolvePayload(string directory, string sourcePath)
    {
        if (!Protocol.IsSafeRelativePath(sourcePath) || sourcePath.Contains('/') || sourcePath.Contains('\\')) throw new BootstrapInstallerException("Stable payload sourcePath must be a safe relative filename.");
        string path = Path.GetFullPath(Path.Combine(directory, sourcePath));
        if (!string.Equals(Path.GetDirectoryName(path), directory, StringComparison.OrdinalIgnoreCase)) throw new BootstrapInstallerException("Stable payload sourcePath escapes the descriptor directory.");
        return path;
    }

    private static VerifiedStablePayloadLease OpenPayload(string path, long size, string sha256, string name)
    {
        SafeFileHandle handle = InstallNative.CreateFileW(path, InstallNative.GenericRead, FileShare.None, IntPtr.Zero, FileMode.Open, InstallNative.OpenReparse | InstallNative.Normal, IntPtr.Zero);
        if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new BootstrapInstallerException(name + " payload open failed.", new Win32Exception(error)); }
        var stream = new FileStream(handle, FileAccess.Read, 131072, false);
        try
        {
            InstallNative.ValidateFile(handle, path); byte[] hash = SHA256.HashData(stream); stream.Position = 0;
            if (stream.Length != size || !CryptographicOperations.FixedTimeEquals(hash, Convert.FromHexString(sha256))) throw new BootstrapInstallerException(name + " payload identity mismatch.");
            return new(stream, stream.Length, sha256);
        }
        catch { stream.Dispose(); throw; }
    }

    private static BootstrapDescriptorV1 Parse(byte[] bytes)
    {
        try
        {
            string text = new UTF8Encoding(false, true).GetString(bytes); using JsonDocument document = JsonDocument.Parse(text, new JsonDocumentOptions { AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow }); JsonElement root = document.RootElement;
            Names(root, "schema", "signature", "launcherVersion", "launcher", "uninstaller", "channelManifestRaw", "selection");
            if (root.GetProperty("schema").GetInt32() != 1) throw new BootstrapInstallerException("Unsupported bootstrap schema.");
            JsonElement sig = root.GetProperty("signature"); Names(sig, "algorithm", "keyId");
            JsonElement artifact = root.GetProperty("launcher"); Names(artifact, "sourcePath", "sha256", "size");
            string source = Need(artifact, "sourcePath");
            if (!Protocol.IsSafeRelativePath(source) || source.Contains('/') || source.Contains('\\')) throw new BootstrapInstallerException("Launcher sourcePath must be a safe relative filename.");
            string sha = Need(artifact, "sha256").ToLowerInvariant(); long size = artifact.GetProperty("size").GetInt64(); if (sha.Length != 64 || !sha.All(Uri.IsHexDigit) || size <= 0) throw new BootstrapInstallerException("Invalid launcher identity.");
            JsonElement uninstaller = root.GetProperty("uninstaller"); Names(uninstaller, "version", "sourcePath", "size", "sha256");
            string uninstallerSource = Need(uninstaller, "sourcePath");
            if (!Protocol.IsSafeRelativePath(uninstallerSource) || uninstallerSource.Contains('/') || uninstallerSource.Contains('\\')) throw new BootstrapInstallerException("Uninstaller sourcePath must be a safe relative filename.");
            string uninstallerSha = Need(uninstaller, "sha256").ToLowerInvariant(); long uninstallerSize = uninstaller.GetProperty("size").GetInt64(); if (uninstallerSha.Length != 64 || !uninstallerSha.All(Uri.IsHexDigit) || uninstallerSize <= 0) throw new BootstrapInstallerException("Invalid uninstaller identity.");
            JsonElement selection = root.GetProperty("selection"); Names(selection, "channel", "buildId", "runtimeId");
            return new(1, new(Need(sig, "algorithm"), Need(sig, "keyId")), Need(root, "launcherVersion"), new(source, sha, size), new(Need(uninstaller, "version"), uninstallerSource, uninstallerSize, uninstallerSha), Need(root, "channelManifestRaw"), new(Need(selection, "channel"), Need(selection, "buildId"), Need(selection, "runtimeId")));
        }
        catch (BootstrapInstallerException) { throw; }
        catch (Exception error) when (error is JsonException or DecoderFallbackException or InvalidOperationException or FormatException or OverflowException) { throw new BootstrapInstallerException("Descriptor does not match strict schema 1.", error); }
    }
    private static string Need(JsonElement element, string name) { string? value = element.GetProperty(name).GetString(); if (string.IsNullOrWhiteSpace(value)) throw new BootstrapInstallerException(name + " is required."); return value; }
    private static void Names(JsonElement element, params string[] names) { if (element.ValueKind != JsonValueKind.Object || !element.EnumerateObject().Select(static p => p.Name).Order().SequenceEqual(names.Order())) throw new BootstrapInstallerException("Unexpected JSON properties."); }
}

internal sealed class BootstrapInstallerOptions
{
    internal string AbsoluteInstallRoot { get; init; } = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MagicPot");
    internal required IInstallIntegration Integration { get; init; }
    internal ILegacyInstallationDetector? LegacyDetector { get; init; }
    internal Func<VerifiedArtifactRequest, CancellationToken, Task<VerifiedArtifactLease>>? ArtifactDownloader { get; init; }
    internal Func<VerifiedArtifactLease, CancellationToken, Task<PreparedArtifactLease>>? ArtifactPreparer { get; init; }
    internal Func<PreparedArtifactPackage, CancellationToken, Task<InstalledArtifactReceipt>>? ArtifactInstaller { get; init; }
    internal Func<VerifiedArtifactRequest, VerifiedArtifactRequest, CancellationToken, Task<BootstrapArtifactInstallResult>>? ArtifactPipeline { get; init; }
    internal Func<DateTimeOffset> Clock { get; init; } = static () => DateTimeOffset.UtcNow;
    internal string? InstallId { get; init; }
    internal Action<string>? CrashHook { get; init; }
}

internal sealed class BootstrapInstallerCore
{
    internal const string OwnershipFileName = "install-ownership.json", JournalFileName = "bootstrap-install-journal.json";
    private static readonly string[] Stages = ["prepared", "stable-binaries-published", "artifacts-installed", "active-committed", "integration-applied"];
    private readonly BootstrapInstallerOptions options; private readonly BootstrapTrustConfiguration trust; private readonly string root; private readonly LauncherLayout layout;
    internal BootstrapInstallerCore(BootstrapInstallerOptions options)
    {
        this.options = options ?? throw new ArgumentNullException(nameof(options)); trust = CompiledBootstrapTrustConfiguration.Create(); if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Bootstrap installer is Windows-only.");
        if (!Path.IsPathFullyQualified(options.AbsoluteInstallRoot)) throw new ArgumentException("AbsoluteInstallRoot must be absolute."); root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(options.AbsoluteInstallRoot)); layout = LauncherLayout.Create(root); ValidateRootPolicy(root);
    }
    internal string Root => root;
    internal string LauncherExe => Path.Combine(root, "Launcher", "MagicPot.Launcher.exe");
    internal string UninstallerExe => Path.Combine(root, "Launcher", "MagicPot.Uninstall.exe");

    internal async Task<BootstrapOwnershipV1> InstallOrRecoverAsync(VerifiedBootstrapBundle bundle, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(bundle);
        if (!string.Equals(bundle.ConfigurationIdentity, trust.Identity, StringComparison.Ordinal)) throw new BootstrapInstallerException("Bootstrap bundle trust identity does not match the compiled installer trust.");
        await using BootstrapTransactionScope transaction = await BootstrapTransactionScope.AcquireAsync(root, cancellationToken).ConfigureAwait(false);
        var state = new BootstrapSafeAtomicFileStore(root, [OwnershipFileName, JournalFileName]); string ownershipPath = Path.Combine(root, OwnershipFileName), journalPath = Path.Combine(root, JournalFileName);
        BootstrapOwnershipV1? ownership = state.Read(ownershipPath, ParseOwnership); BootstrapInstallJournalV1? journal = state.Read(journalPath, ParseJournal);
        string installId = ownership?.InstallId ?? journal?.InstallId ?? options.InstallId ?? Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture);
        if (!Guid.TryParseExact(installId, "N", out _) || options.InstallId is not null && !string.Equals(options.InstallId, installId, StringComparison.Ordinal)) throw new BootstrapInstallerException("installId conflicts with existing state.");
        if (ownership is null && journal is null) RejectUnownedNonEmpty();
        string operationId = ownership?.OperationId ?? journal?.OperationId ?? Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture); string createdAt = ownership?.CreatedAt ?? journal?.CreatedAt ?? LauncherTime.Timestamp(options.Clock());
        string launcherTemporaryName = journal?.LauncherTemporaryName ?? ".launcher-" + operationId + ".partial";
        string uninstallerTemporaryName = journal?.UninstallerTemporaryName ?? ".uninstaller-" + operationId + ".partial";
        ValidateTemporaryName(launcherTemporaryName, operationId, "launcher"); ValidateTemporaryName(uninstallerTemporaryName, operationId, "uninstaller");
        string? legacySource = ownership?.LegacySource ?? journal?.LegacySource;
        if (ownership is null && journal is null) legacySource = ValidateLegacySource(options.LegacyDetector?.Detect()?.Path, root);
        var expectedOwnership = new BootstrapOwnershipV1(1, operationId, installId, root, bundle.Descriptor.Launcher.Sha256, bundle.Descriptor.Launcher.Size, bundle.Descriptor.LauncherVersion, bundle.Descriptor.Uninstaller.Sha256, bundle.Descriptor.Uninstaller.Size, bundle.Descriptor.Uninstaller.Version, bundle.Selection.App.BuildId, bundle.Selection.Runtime.RuntimeId, createdAt, legacySource);
        if (ownership is not null)
        {
            ValidateOwnership(ownership, expectedOwnership);
            if (journal is not null)
            {
                ValidateJournal(journal, expectedOwnership, bundle.DescriptorIdentity);
                if (!string.Equals(journal.Stage, "integration-applied", StringComparison.Ordinal)) throw new BootstrapInstallerException("Ownership may coexist only with a completed integration journal.");
            }
            VerifyStableBinary(LauncherExe, bundle.Descriptor.Launcher.Size, bundle.Descriptor.Launcher.Sha256, "launcher");
            VerifyStableBinary(UninstallerExe, bundle.Descriptor.Uninstaller.Size, bundle.Descriptor.Uninstaller.Sha256, "uninstaller");
            RequireArtifact(Path.Combine(layout.Apps, ownership.ActiveBuildId), Path.Combine(layout.Apps, ownership.ActiveBuildId));
            RequireArtifact(Path.Combine(layout.Runtimes, ownership.ActiveRuntimeId), Path.Combine(layout.Runtimes, ownership.ActiveRuntimeId));
            InstalledSelection? installed = new InstalledSelectionResolver(layout).ResolveActive();
            if (installed is null || installed.Pointer.ActiveBuildId != ownership.ActiveBuildId || installed.Pointer.ActiveRuntimeId != ownership.ActiveRuntimeId)
                throw new BootstrapInstallerException("Installed artifacts or active state do not match ownership.");
            InstallIntegrationState integrationState = options.Integration.Inspect(operationId, ownership);
            if (integrationState != InstallIntegrationState.Applied) throw new BootstrapInstallerException("Install integration is not applied for ownership.");
            options.Integration.Verify(operationId, ownership, LauncherExe);
            if (journal is not null) state.Delete(journalPath);
            return ownership;
        }
        if (journal is not null) ValidateJournal(journal, expectedOwnership, bundle.DescriptorIdentity);
        else { journal = Journal("prepared"); state.Write(journalPath, journal, ParseJournal); Crash("prepared"); }

        if (At(journal.Stage) < At("stable-binaries-published"))
        {
            PublishStableBinary(LauncherExe, bundle.LauncherPayload, journal.LauncherTemporaryName, "launcher");
            PublishStableBinary(UninstallerExe, bundle.UninstallerPayload, journal.UninstallerTemporaryName, "uninstaller");
            VerifyStableBinary(LauncherExe, bundle.Descriptor.Launcher.Size, bundle.Descriptor.Launcher.Sha256, "launcher");
            VerifyStableBinary(UninstallerExe, bundle.Descriptor.Uninstaller.Size, bundle.Descriptor.Uninstaller.Sha256, "uninstaller");
            journal = Advance("stable-binaries-published", journal);
        }
        else
        {
            VerifyStableBinary(LauncherExe, bundle.Descriptor.Launcher.Size, bundle.Descriptor.Launcher.Sha256, "launcher");
            VerifyStableBinary(UninstallerExe, bundle.Descriptor.Uninstaller.Size, bundle.Descriptor.Uninstaller.Sha256, "uninstaller");
        }

        if (At(journal.Stage) < At("artifacts-installed"))
        {
            BootstrapArtifactInstallResult installed = await InstallArtifacts(bundle, cancellationToken).ConfigureAwait(false); RequireArtifact(installed.AppDirectory, Path.Combine(layout.Apps, bundle.Selection.App.BuildId)); RequireArtifact(installed.RuntimeDirectory, Path.Combine(layout.Runtimes, bundle.Selection.Runtime.RuntimeId)); journal = Advance("artifacts-installed", journal);
        }
        else { RequireArtifact(Path.Combine(layout.Apps, bundle.Selection.App.BuildId), Path.Combine(layout.Apps, bundle.Selection.App.BuildId)); RequireArtifact(Path.Combine(layout.Runtimes, bundle.Selection.Runtime.RuntimeId), Path.Combine(layout.Runtimes, bundle.Selection.Runtime.RuntimeId)); }

        var active = new ActivePointerV1(1, bundle.Selection.App.BuildId, bundle.Selection.Runtime.RuntimeId, null, null, createdAt);
        if (At(journal.Stage) < At("active-committed")) { BootstrapActivationInitializer.InitializeCurrent(layout, active); journal = Advance("active-committed", journal); }
        else if (!LocalActivationStore.Same(LocalActivationStore.ReadCurrent(layout), active)) throw new BootstrapInstallerException("Active state conflicts with bootstrap journal.");

        if (At(journal.Stage) < At("integration-applied"))
        {
            InstallIntegrationState inspection = options.Integration.Inspect(operationId, expectedOwnership);
            if (inspection == InstallIntegrationState.Conflict) throw new BootstrapInstallerException("Install integration is owned by a different operation.");
            if (inspection == InstallIntegrationState.Missing)
            {
                try { options.Integration.Apply(operationId, expectedOwnership, LauncherExe); }
                catch { try { options.Integration.Rollback(operationId, expectedOwnership, LauncherExe); } catch { } throw; }
                Crash("integration-apply-returned");
            }
            options.Integration.Verify(operationId, expectedOwnership, LauncherExe); journal = Advance("integration-applied", journal);
        }
        else options.Integration.Verify(operationId, expectedOwnership, LauncherExe);

        state.Write(ownershipPath, expectedOwnership, ParseOwnership); ValidateOwnership(state.Read(ownershipPath, ParseOwnership)!, expectedOwnership); Crash("after-ownership-write"); state.Delete(journalPath); return expectedOwnership;

        BootstrapInstallJournalV1 Journal(string stage) => new(1, stage, operationId, installId, bundle.DescriptorIdentity, bundle.Descriptor.Launcher.Sha256, bundle.Descriptor.Launcher.Size, bundle.Descriptor.LauncherVersion, bundle.Descriptor.Uninstaller.Sha256, bundle.Descriptor.Uninstaller.Size, bundle.Descriptor.Uninstaller.Version, bundle.Selection.App.BuildId, bundle.Selection.Runtime.RuntimeId, createdAt, legacySource, launcherTemporaryName, uninstallerTemporaryName);
        BootstrapInstallJournalV1 Advance(string stage, BootstrapInstallJournalV1 previous) { if (At(stage) != At(previous.Stage) + 1) throw new BootstrapInstallerException("Invalid bootstrap stage transition."); BootstrapInstallJournalV1 next = Journal(stage); state.Write(journalPath, next, ParseJournal); Crash(stage); return next; }
        void Crash(string point) => options.CrashHook?.Invoke(point);
    }

    private async Task<BootstrapArtifactInstallResult> InstallArtifacts(VerifiedBootstrapBundle bundle, CancellationToken token)
    {
        if (options.ArtifactPipeline is not null) return await options.ArtifactPipeline(bundle.AppRequest, bundle.RuntimeRequest, token).ConfigureAwait(false);
        if (options.ArtifactDownloader is null || options.ArtifactPreparer is null || options.ArtifactInstaller is null) throw new BootstrapInstallerException("Downloader/preparer/installer factories are required.");
        async Task<InstalledArtifactReceipt> One(VerifiedArtifactRequest request) { await using VerifiedArtifactLease downloaded = await options.ArtifactDownloader(request, token).ConfigureAwait(false); await using PreparedArtifactLease prepared = await options.ArtifactPreparer(downloaded, token).ConfigureAwait(false); using PreparedArtifactPackage package = prepared.TakeOwnership(); return await options.ArtifactInstaller(package, token).ConfigureAwait(false); }
        using InstalledArtifactReceipt app = await One(bundle.AppRequest).ConfigureAwait(false); using InstalledArtifactReceipt runtime = await One(bundle.RuntimeRequest).ConfigureAwait(false); app.ValidateForActivation(); runtime.ValidateForActivation(); return new(app.FinalPath, runtime.FinalPath);
    }

    private void PublishStableBinary(string destination, VerifiedStablePayloadLease payload, string temporaryName, string name)
    {
        string directory = Path.GetDirectoryName(destination)!; BootstrapTransactionScope.CreateAndValidateDirectory(directory);
        SafeFileHandle existing = InstallNative.CreateFileW(destination, InstallNative.GenericRead, FileShare.Read, IntPtr.Zero, FileMode.Open, InstallNative.OpenReparse, IntPtr.Zero);
        if (!existing.IsInvalid) { using (existing) { InstallNative.ValidateFile(existing, destination); if (HandleMatches(existing, payload.Size, payload.Sha256)) return; } throw new BootstrapInstallerException("Existing " + name + " differs; bootstrap self-update is forbidden."); }
        int openError = Marshal.GetLastWin32Error(); existing.Dispose(); if (openError is not (2 or 3)) throw new BootstrapInstallerException("Existing " + name + " inspection failed.", new Win32Exception(openError));
        string partial = Path.Combine(directory, temporaryName);
        SafeFileHandle output = InstallNative.CreateFileW(partial, InstallNative.GenericRead | InstallNative.GenericWrite | InstallNative.Delete, FileShare.Read | FileShare.Delete, IntPtr.Zero, FileMode.Open, InstallNative.Normal | InstallNative.OpenReparse | InstallNative.WriteThrough, IntPtr.Zero);
        if (!output.IsInvalid)
        {
            try
            {
                InstallNative.ValidateFile(output, partial);
                if (HandleMatches(output, payload.Size, payload.Sha256))
                {
                    BootstrapNative.RenameByHandle(output, destination, replace: false);
                    VerifyStableBinary(destination, payload.Size, payload.Sha256, name);
                    return;
                }
                InstallNative.DeleteByHandle(output);
            }
            finally { output.Dispose(); }
            if (File.Exists(partial) || Directory.Exists(partial)) throw new BootstrapInstallerException(name + " partial delete did not complete.");
        }
        else
        {
            int partialError = Marshal.GetLastWin32Error(); output.Dispose();
            if (partialError is not (2 or 3)) throw new BootstrapInstallerException(name + " partial inspection failed.", new Win32Exception(partialError));
        }
        payload.Stream.Position = 0;
        output = InstallNative.CreateFileW(partial, InstallNative.GenericRead | InstallNative.GenericWrite | InstallNative.Delete, FileShare.Read, IntPtr.Zero, FileMode.CreateNew, InstallNative.Normal | InstallNative.OpenReparse | InstallNative.WriteThrough, IntPtr.Zero);
        if (output.IsInvalid) throw new BootstrapInstallerException(name + " partial create failed.", new Win32Exception(Marshal.GetLastWin32Error()));
        using (output)
        {
            InstallNative.ValidateFile(output, partial); InstalledFileIdentity identity = InstallNative.Identity(output);
            using (var borrowedOutput = new SafeFileHandle(output.DangerousGetHandle(), ownsHandle: false))
            using (var outputStream = new FileStream(borrowedOutput, FileAccess.Write, 131072, false))
            {
                payload.Stream.CopyTo(outputStream);
                outputStream.Flush(true);
            }
            if (InstallNative.Identity(output) != identity || !HandleMatches(output, payload.Size, payload.Sha256)) throw new BootstrapInstallerException(name + " partial mismatch.");
            BootstrapNative.RenameByHandle(output, destination, replace: false); if (InstallNative.Identity(output) != identity || !HandleMatches(output, payload.Size, payload.Sha256)) throw new BootstrapInstallerException(name + " post-publish mismatch.");
        }
        VerifyStableBinary(destination, payload.Size, payload.Sha256, name);
    }

    private static void VerifyStableBinary(string path, long size, string sha, string name)
    {
        SafeFileHandle handle = InstallNative.CreateFileW(path, InstallNative.GenericRead, FileShare.Read, IntPtr.Zero, FileMode.Open, InstallNative.OpenReparse, IntPtr.Zero);
        if (handle.IsInvalid) throw new BootstrapInstallerException("Published " + name + " is missing."); using (handle) { InstallNative.ValidateFile(handle, path); if (!HandleMatches(handle, size, sha)) throw new BootstrapInstallerException("Published " + name + " identity mismatch."); }
    }
    private static bool HandleMatches(SafeFileHandle handle, long size, string sha)
    {
        if (RandomAccess.GetLength(handle) != size) return false;
        using var borrowed = new SafeFileHandle(handle.DangerousGetHandle(), ownsHandle: false);
        using var stream = new FileStream(borrowed, FileAccess.Read, 131072, false);
        stream.Position = 0;
        return CryptographicOperations.FixedTimeEquals(SHA256.HashData(stream), Convert.FromHexString(sha));
    }
    private void RejectUnownedNonEmpty()
    {
        string[] allowedNames = [".bootstrap-lock", JournalFileName, "Launcher", "apps", "runtimes", "downloads", "staging"];
        foreach (string path in Directory.EnumerateFileSystemEntries(root))
        {
            string name = Path.GetFileName(path); if (allowedNames.Contains(name, StringComparer.OrdinalIgnoreCase)) continue; if (name.StartsWith(".bootstrap-", StringComparison.OrdinalIgnoreCase) && name.EndsWith(".partial", StringComparison.OrdinalIgnoreCase)) continue; throw new BootstrapInstallerException("Non-empty unowned install root.");
        }
    }
    private static void RequireArtifact(string actual, string expected) { if (!string.Equals(InstallNative.Normalize(actual), InstallNative.Normalize(expected), StringComparison.OrdinalIgnoreCase) || !Directory.Exists(actual)) throw new BootstrapInstallerException("Artifact escaped selected identity or is missing."); using SafeFileHandle handle = InstallNative.OpenDirectory(actual, InstallNative.ReadAttributes, FileShare.ReadWrite); InstallNative.ValidateDirectory(handle, actual); }
    private static int At(string stage) { int index = Array.IndexOf(Stages, stage); if (index < 0) throw new BootstrapInstallerException("Unknown bootstrap stage."); return index; }
    private static void ValidateOwnership(BootstrapOwnershipV1 actual, BootstrapOwnershipV1 expected) { if (actual != expected) throw new BootstrapInstallerException("Ownership conflict."); }
    private static void ValidateJournal(BootstrapInstallJournalV1 journal, BootstrapOwnershipV1 expected, string descriptorIdentity) { _ = At(journal.Stage); ValidateTemporaryName(journal.LauncherTemporaryName, journal.OperationId, "launcher"); ValidateTemporaryName(journal.UninstallerTemporaryName, journal.OperationId, "uninstaller"); if (journal.Schema != 1 || journal.OperationId != expected.OperationId || journal.InstallId != expected.InstallId || journal.DescriptorIdentity != descriptorIdentity || journal.LauncherSha256 != expected.LauncherSha256 || journal.LauncherSize != expected.LauncherSize || journal.LauncherVersion != expected.LauncherVersion || journal.UninstallerSha256 != expected.UninstallerSha256 || journal.UninstallerSize != expected.UninstallerSize || journal.UninstallerVersion != expected.UninstallerVersion || journal.ActiveBuildId != expected.ActiveBuildId || journal.ActiveRuntimeId != expected.ActiveRuntimeId || journal.CreatedAt != expected.CreatedAt || journal.LegacySource != expected.LegacySource) throw new BootstrapInstallerException("Journal conflict."); }

    internal static BootstrapOwnershipV1? ReadOwnership(string path) => new BootstrapSafeAtomicFileStore(Path.GetDirectoryName(path)!, [Path.GetFileName(path)]).Read(path, ParseOwnership);
    internal static BootstrapOwnershipV1 ParseOwnership(string text)
    {
        using JsonDocument document = StrictDocument(text); JsonElement e = document.RootElement; Names(e, "schema", "operationId", "installId", "root", "launcherSha256", "launcherSize", "launcherVersion", "uninstallerSha256", "uninstallerSize", "uninstallerVersion", "activeBuildId", "activeRuntimeId", "createdAt", "legacySource");
        return new(e.GetProperty("schema").GetInt32(), S(e, "operationId"), S(e, "installId"), S(e, "root"), S(e, "launcherSha256"), e.GetProperty("launcherSize").GetInt64(), S(e, "launcherVersion"), S(e, "uninstallerSha256"), e.GetProperty("uninstallerSize").GetInt64(), S(e, "uninstallerVersion"), S(e, "activeBuildId"), S(e, "activeRuntimeId"), S(e, "createdAt"), e.GetProperty("legacySource").ValueKind == JsonValueKind.Null ? null : e.GetProperty("legacySource").GetString());
    }
    private static BootstrapInstallJournalV1 ParseJournal(string text)
    {
        using JsonDocument document = StrictDocument(text); JsonElement e = document.RootElement; Names(e, "schema", "stage", "operationId", "installId", "descriptorIdentity", "launcherSha256", "launcherSize", "launcherVersion", "uninstallerSha256", "uninstallerSize", "uninstallerVersion", "activeBuildId", "activeRuntimeId", "createdAt", "legacySource", "launcherTemporaryName", "uninstallerTemporaryName");
        return new(e.GetProperty("schema").GetInt32(), S(e, "stage"), S(e, "operationId"), S(e, "installId"), S(e, "descriptorIdentity"), S(e, "launcherSha256"), e.GetProperty("launcherSize").GetInt64(), S(e, "launcherVersion"), S(e, "uninstallerSha256"), e.GetProperty("uninstallerSize").GetInt64(), S(e, "uninstallerVersion"), S(e, "activeBuildId"), S(e, "activeRuntimeId"), S(e, "createdAt"), e.GetProperty("legacySource").ValueKind == JsonValueKind.Null ? null : S(e, "legacySource"), S(e, "launcherTemporaryName"), S(e, "uninstallerTemporaryName"));
    }
    private static JsonDocument StrictDocument(string text) => JsonDocument.Parse(text, new JsonDocumentOptions { AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow });
    private static string S(JsonElement e, string name) { string? value = e.GetProperty(name).GetString(); if (string.IsNullOrWhiteSpace(value)) throw new BootstrapInstallerException("Missing state value: " + name); return value; }
    private static void Names(JsonElement e, params string[] names) { if (e.ValueKind != JsonValueKind.Object || !e.EnumerateObject().Select(static p => p.Name).Order().SequenceEqual(names.Order())) throw new BootstrapInstallerException("Strict state schema mismatch."); }
    private static string? ValidateLegacySource(string? value, string installRoot)
    {
        _ = installRoot;
        if (value is null) return null;
        if (value.Length is < 1 or > 256 || value.Any(static c => c < ' ')) throw new BootstrapInstallerException("Legacy source label is invalid.");
        return value;
    }
    private static void ValidateTemporaryName(string value, string operationId, string binary)
    {
        if (!string.Equals(value, "." + binary + "-" + operationId + ".partial", StringComparison.Ordinal) || value != Path.GetFileName(value)) throw new BootstrapInstallerException("Unsafe " + binary + " temporary name.");
    }
    private static void ValidateRootPolicy(string value)
    {
        foreach (string? blocked in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.Windows) }) if (!string.IsNullOrEmpty(blocked) && Below(value, blocked)) throw new BootstrapInstallerException("Protected system root.");
        string? volume = Path.GetPathRoot(value); if (!string.IsNullOrEmpty(volume) && Path.TrimEndingDirectorySeparator(value).Equals(Path.TrimEndingDirectorySeparator(volume), StringComparison.OrdinalIgnoreCase)) throw new BootstrapInstallerException("Volume root is forbidden.");
    }
    private static bool Below(string path, string ancestor) { ancestor = Path.TrimEndingDirectorySeparator(Path.GetFullPath(ancestor)); return path.Equals(ancestor, StringComparison.OrdinalIgnoreCase) || path.StartsWith(ancestor + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase); }
}

internal static class BootstrapActivationInitializer
{
    internal static void InitializeCurrent(LauncherLayout layout, ActivePointerV1 to)
    {
        using var scope = new ActivationStateTransactionScope(layout); ActivePointerV1? current = scope.SafeReadJson(layout.ActivePointer, Protocol.ParseActivePointer); ActivationJournalV1? journal = scope.SafeReadJson(layout.ActivationJournal, ParseActivationJournal);
        if (journal is not null) throw new BootstrapInstallerException("Activation journal exists during first initialization.");
        if (current is not null) { if (LocalActivationStore.Same(current, to)) return; throw new BootstrapInstallerException("A different active selection already exists."); }
        scope.SafeAtomicWrite(layout.ActivePointer, to, Protocol.ParseActivePointer); scope.SafeAtomicWrite(layout.Health, new LauncherHealthStateV1(1, 0), Protocol.ParseHealth);
    }
    private static ActivationJournalV1 ParseActivationJournal(string text) { using JsonDocument document = JsonDocument.Parse(text); JsonElement e = document.RootElement; if (e.GetProperty("schema").GetInt32() != 1) throw new BootstrapInstallerException("Invalid activation journal."); throw new BootstrapInstallerException("Activation journal exists during first initialization."); }
}

internal sealed class BootstrapTransactionScope : IAsyncDisposable
{
    private readonly List<SafeFileHandle> pins = [];
    private WindowsNamedMutexLease? mutex;
    private UpdateFileLock? fileLock;
    private BootstrapTransactionScope() { }
    internal static async Task<BootstrapTransactionScope> AcquireAsync(string root, CancellationToken token)
    {
        var scope = new BootstrapTransactionScope();
        try
        {
            scope.CreatePinChain(root); string identity = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(root.ToUpperInvariant()))).ToLowerInvariant(); scope.mutex = await WindowsNamedMutexLease.AcquireAsync("Local\\MagicPot.Bootstrap." + identity, TimeSpan.FromSeconds(5), TimeSpan.FromMilliseconds(50), token).ConfigureAwait(false);
            string launcherRoot = Path.Combine(root, "Launcher"); CreateAndValidateDirectory(launcherRoot); scope.Pin(launcherRoot);
            string lockRoot = Path.Combine(root, ".bootstrap-lock"); CreateAndValidateDirectory(lockRoot); scope.Pin(lockRoot); scope.fileLock = UpdateFileLock.Acquire(lockRoot, TimeSpan.FromSeconds(5), TimeSpan.FromMilliseconds(50)); return scope;
        }
        catch { await scope.DisposeAsync().ConfigureAwait(false); throw; }
    }
    private void CreatePinChain(string target)
    {
        string normalized = InstallNative.Normalize(target); string volume = Path.GetPathRoot(normalized) ?? throw new BootstrapInstallerException("Install root has no volume."); string current = volume; Pin(current);
        foreach (string part in normalized[volume.Length..].Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)) { if (part.Length == 0) continue; current = Path.Combine(current, part); CreateAndValidateDirectory(current); Pin(current); }
    }
    internal static void CreateAndValidateDirectory(string path) { if (!Directory.Exists(path) && !InstallNative.CreateDirectoryW(path, IntPtr.Zero) && Marshal.GetLastWin32Error() != 183) throw new BootstrapInstallerException("Directory creation failed.", new Win32Exception(Marshal.GetLastWin32Error())); using SafeFileHandle handle = InstallNative.OpenDirectory(path, InstallNative.ReadAttributes, FileShare.ReadWrite); InstallNative.ValidateDirectory(handle, path); if (BootstrapNative.IsCaseSensitive(handle)) throw new BootstrapInstallerException("Case-sensitive install directory is forbidden."); }
    private void Pin(string path) { SafeFileHandle handle = InstallNative.OpenDirectory(path, InstallNative.ReadAttributes, FileShare.ReadWrite); try { InstallNative.ValidateDirectory(handle, path); if (BootstrapNative.IsCaseSensitive(handle)) throw new BootstrapInstallerException("Case-sensitive install chain is forbidden."); pins.Add(handle); } catch { handle.Dispose(); throw; } }
    public async ValueTask DisposeAsync() { fileLock?.Dispose(); if (mutex is not null) await mutex.DisposeAsync().ConfigureAwait(false); for (int i = pins.Count - 1; i >= 0; i--) pins[i].Dispose(); }
}

internal sealed class BootstrapSafeAtomicFileStore
{
    private readonly string root; private readonly HashSet<string> allowed;
    internal BootstrapSafeAtomicFileStore(string root, IEnumerable<string> names) { this.root = InstallNative.Normalize(root); allowed = new(names, StringComparer.OrdinalIgnoreCase); }
    internal T? Read<T>(string path, Func<string, T> parse) where T : class
    {
        Require(path); SafeFileHandle handle = Open(path, InstallNative.GenericRead, FileMode.Open); if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); if (error is 2 or 3) return null; throw new BootstrapInstallerException("Bootstrap state open failed.", new Win32Exception(error)); }
        using (handle) { InstallNative.ValidateFile(handle, path); return parse(ReadUtf8(handle)); }
    }
    internal void Write<T>(string path, T value, Func<string, T> parse) where T : class
    {
        Require(path); InspectExisting(path); byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(value, new JsonSerializerOptions(JsonSerializerDefaults.Web)); string temp = Path.Combine(root, ".bootstrap-" + Path.GetFileName(path) + "-" + Guid.NewGuid().ToString("N") + ".partial"); SafeFileHandle handle = Open(temp, InstallNative.GenericRead | InstallNative.GenericWrite | InstallNative.Delete, FileMode.CreateNew);
        if (handle.IsInvalid) throw new BootstrapInstallerException("Bootstrap state temporary create failed.", new Win32Exception(Marshal.GetLastWin32Error()));
        using (handle) { InstallNative.ValidateFile(handle, temp); InstalledFileIdentity identity = InstallNative.Identity(handle); RandomAccess.Write(handle, bytes, 0); RandomAccess.FlushToDisk(handle); if (InstallNative.Identity(handle) != identity || !CryptographicOperations.FixedTimeEquals(bytes, ReadBytes(handle))) throw new BootstrapInstallerException("Bootstrap state temporary changed."); _ = parse(new UTF8Encoding(false, true).GetString(bytes)); BootstrapNative.RenameByHandle(handle, path, replace: true); if (InstallNative.Identity(handle) != identity || !CryptographicOperations.FixedTimeEquals(bytes, ReadBytes(handle))) throw new BootstrapInstallerException("Bootstrap state publish changed."); }
    }
    internal void Delete(string path)
    {
        Require(path); SafeFileHandle handle = Open(path, InstallNative.GenericRead | InstallNative.Delete, FileMode.Open); if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); if (error is 2 or 3) return; throw new BootstrapInstallerException("Bootstrap state delete open failed.", new Win32Exception(error)); } using (handle) { InstallNative.ValidateFile(handle, path); InstallNative.DeleteByHandle(handle); }
    }
    private SafeFileHandle Open(string path, uint access, FileMode mode) => InstallNative.CreateFileW(path, access, FileShare.Read, IntPtr.Zero, mode, InstallNative.Normal | InstallNative.OpenReparse | InstallNative.WriteThrough, IntPtr.Zero);
    private void Require(string path) { string normalized = InstallNative.Normalize(path); if (!string.Equals(Path.GetDirectoryName(normalized), root, StringComparison.OrdinalIgnoreCase) || !allowed.Contains(Path.GetFileName(normalized))) throw new BootstrapInstallerException("Bootstrap state path is not an allowed direct child."); }
    private void InspectExisting(string path) { SafeFileHandle handle = Open(path, InstallNative.GenericRead, FileMode.Open); if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); if (error is 2 or 3) return; throw new BootstrapInstallerException("Existing bootstrap state inspection failed.", new Win32Exception(error)); } using (handle) InstallNative.ValidateFile(handle, path); }
    private static string ReadUtf8(SafeFileHandle handle) => new UTF8Encoding(false, true).GetString(ReadBytes(handle));
    private static byte[] ReadBytes(SafeFileHandle handle) { long length = RandomAccess.GetLength(handle); if (length < 0 || length > 1024 * 1024) throw new BootstrapInstallerException("Bootstrap state size is invalid."); byte[] bytes = new byte[(int)length]; int read = 0; while (read < bytes.Length) { int count = RandomAccess.Read(handle, bytes.AsSpan(read), read); if (count == 0) throw new EndOfStreamException(); read += count; } return bytes; }
}

internal sealed record UninstallOwnedEntry(string Path, bool Directory, InstalledFileIdentity Identity, long Length, byte[]? Sha256, byte[]? DirectoryFingerprint);
internal sealed record OwnedHandle(UninstallOwnedEntry Entry, SafeFileHandle Handle);
internal sealed class UninstallCapability : IDisposable
{
    private readonly List<SafeFileHandle> ancestors; private readonly List<OwnedHandle> ownedHandles; private bool disposed;
    internal UninstallCapability(string root, string installId, IReadOnlyList<string> fixedPaths, IReadOnlyList<string> preservedPaths, List<SafeFileHandle> ancestors, List<OwnedHandle> ownedHandles) { Root = root; InstallId = installId; FixedPaths = fixedPaths; PreservedPaths = preservedPaths; this.ancestors = ancestors; this.ownedHandles = ownedHandles; }
    internal string Root { get; }
    internal string InstallId { get; }
    internal IReadOnlyList<string> FixedPaths { get; }
    internal IReadOnlyList<string> PreservedPaths { get; }
    internal bool Completed { get; private set; }
    internal IReadOnlyList<Exception> CleanupFailures => cleanupFailures;
    private readonly List<Exception> cleanupFailures = [];
    internal void ValidateStillOwned()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        foreach (OwnedHandle owned in ownedHandles)
        {
            UninstallOwnedEntry entry = owned.Entry;
            if (entry.Directory)
            {
                InstallNative.ValidateDirectory(owned.Handle, entry.Path);
                if (InstallNative.Identity(owned.Handle) != entry.Identity || entry.Length != -1 || entry.Sha256 is not null || entry.DirectoryFingerprint is null || !CryptographicOperations.FixedTimeEquals(UninstallCapabilityBuilder.TopDirectoryFingerprint(owned.Handle, entry.Path), entry.DirectoryFingerprint)) throw new BootstrapInstallerException("Held uninstall directory changed.");
            }
            else if (entry.Sha256 is null || entry.DirectoryFingerprint is not null || !UninstallCapabilityBuilder.FileMatches(owned.Handle, entry.Identity, entry.Length, entry.Sha256)) throw new BootstrapInstallerException("Held uninstall file changed.");

            if (!InstallNative.Canonical(owned.Handle).Equals(InstallNative.Normalize(entry.Path), StringComparison.OrdinalIgnoreCase))
                throw new BootstrapInstallerException("Held uninstall object no longer has its owned path.");
        }
    }
    internal void ExecuteDeleteOwnedTree() => Execute();
    internal void Execute()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (Completed) return;
        ValidateStillOwned();
        cleanupFailures.Clear();
        IEnumerable<OwnedHandle> ordered = ownedHandles.OrderBy(static value => value.Entry.Directory).ThenByDescending(static value => value.Entry.Path.Count(static c => c is '\\' or '/'));
        foreach (OwnedHandle owned in ordered.ToArray())
        {
            try
            {
                InstallNative.DeleteByHandle(owned.Handle);
                owned.Handle.Dispose();
                ownedHandles.Remove(owned);
            }
            catch (Exception error) { cleanupFailures.Add(error); }
        }
        for (int i = 0; i < ownedHandles.Count; i++)
        {
            OwnedHandle remaining = ownedHandles[i];
            if (remaining.Entry.Directory && Directory.Exists(remaining.Entry.Path)) ownedHandles[i] = remaining with { Entry = remaining.Entry with { DirectoryFingerprint = UninstallCapabilityBuilder.TopDirectoryFingerprint(remaining.Handle, remaining.Entry.Path) } };
        }
        if (cleanupFailures.Count != 0) throw new BootstrapInstallerException("Owned uninstall cleanup was incomplete.", new AggregateException(cleanupFailures));
        Completed = true;
        Dispose();
    }
    internal void RetryDelete() => Execute();
    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        for (int i = ownedHandles.Count - 1; i >= 0; i--) ownedHandles[i].Handle.Dispose();
        ownedHandles.Clear();
        for (int i = ancestors.Count - 1; i >= 0; i--) ancestors[i].Dispose();
        ancestors.Clear();
    }
}
internal static class UninstallCapabilityBuilder
{
    internal static UninstallCapability Build(string absoluteRoot, string expectedInstallId, string? externalUserData = null)
    {
        string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(absoluteRoot));
        string ownershipPath = Path.Combine(root, BootstrapInstallerCore.OwnershipFileName);
        var ancestors = new List<SafeFileHandle>(); var handles = new List<OwnedHandle>();
        SafeFileHandle? ownershipHandle = null;
        try
        {
            ownershipHandle = OpenOwned(ownershipPath, directory: false);
            InstallNative.ValidateFile(ownershipHandle, ownershipPath);
            BootstrapOwnershipV1 ownership = ReadOwnership(ownershipHandle);
            if (ownership.Schema != 1) throw new BootstrapInstallerException("Unsupported ownership schema.");

            string volume = Path.GetPathRoot(root) ?? throw new BootstrapInstallerException("Uninstall root has no volume."); string current = volume; PinAncestor(current);
            foreach (string part in root[volume.Length..].Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)) { if (part.Length == 0) continue; current = Path.Combine(current, part); PinAncestor(current); }
            string canonicalRoot = InstallNative.Canonical(ancestors[^1]);
            if (!string.Equals(canonicalRoot, root, StringComparison.OrdinalIgnoreCase)) throw new BootstrapInstallerException("Uninstall root is not canonical.");
            string ownershipParent = Path.GetDirectoryName(InstallNative.Canonical(ownershipHandle)) ?? string.Empty;
            if (!string.Equals(ownershipParent, canonicalRoot, StringComparison.OrdinalIgnoreCase) || InstallNative.Identity(ownershipHandle).VolumeSerialNumber != InstallNative.Identity(ancestors[^1]).VolumeSerialNumber) throw new BootstrapInstallerException("Ownership file is outside the pinned uninstall root.");
            if (ownership.InstallId != expectedInstallId || !ownership.Root.Equals(root, StringComparison.OrdinalIgnoreCase)) throw new BootstrapInstallerException("Ownership mismatch.");

            SafeFileHandle rootReadHandle = ancestors[^1];
            rootReadHandle.Dispose();
            ancestors.RemoveAt(ancestors.Count - 1);
            SafeFileHandle rootHandle = InstallNative.OpenDirectory(root, InstallNative.GenericRead | InstallNative.ReadAttributes | InstallNative.Delete, FileShare.Read);
            try { InstallNative.ValidateDirectory(rootHandle, root); if (!string.Equals(InstallNative.Canonical(rootHandle), canonicalRoot, StringComparison.OrdinalIgnoreCase)) throw new BootstrapInstallerException("Uninstall root changed after ownership validation."); if (BootstrapNative.IsCaseSensitive(rootHandle)) throw new BootstrapInstallerException("Case-sensitive uninstall root is forbidden."); }
            catch { rootHandle.Dispose(); throw; }
            handles.Add(new(new(root, true, InstallNative.Identity(rootHandle), -1, null, null), rootHandle));
            (InstalledFileIdentity ownershipIdentity, long ownershipLength, byte[] ownershipSha256) = CaptureFile(ownershipHandle);
            handles.Add(new(new(ownershipPath, false, ownershipIdentity, ownershipLength, ownershipSha256, null), ownershipHandle));
            ownershipHandle = null;

            string[] owned = [Path.Combine(root, "Launcher"), Path.Combine(root, "apps"), Path.Combine(root, "runtimes"), Path.Combine(root, "active.json"), Path.Combine(root, "activation-journal.json"), Path.Combine(root, "launcher-health.json"), Path.Combine(root, ".health-lock"), Path.Combine(root, "launcher.log.jsonl"), Path.Combine(root, "downloads"), Path.Combine(root, "staging"), Path.Combine(root, ".bootstrap-lock"), ownershipPath, Path.Combine(root, BootstrapInstallerCore.JournalFileName)];
            foreach (string path in owned)
            {
                string full = InstallNative.Normalize(path); if (!InstallNative.IsStrictlyContained(root, full)) throw new BootstrapInstallerException("Unsafe uninstall path.");
                if (string.Equals(full, InstallNative.Normalize(ownershipPath), StringComparison.OrdinalIgnoreCase)) continue;
                if (Directory.Exists(full)) CaptureTree(full); else if (File.Exists(full)) Capture(full, false);
            }
            BootstrapOwnershipV1 finalOwnership = ReadOwnership(handles[1].Handle);
            if (finalOwnership != ownership) throw new BootstrapInstallerException("Ownership changed while building uninstall capability.");
            for (int i = 0; i < handles.Count; i++)
            {
                OwnedHandle ownedHandle = handles[i];
                if (ownedHandle.Entry.Directory) handles[i] = ownedHandle with { Entry = ownedHandle.Entry with { DirectoryFingerprint = TopDirectoryFingerprint(ownedHandle.Handle, ownedHandle.Entry.Path) } };
            }
            var capability = new UninstallCapability(root, expectedInstallId, owned, externalUserData is null ? [] : [externalUserData], ancestors, handles);
            capability.ValidateStillOwned();
            return capability;
        }
        catch
        {
            ownershipHandle?.Dispose();
            for (int i = handles.Count - 1; i >= 0; i--) handles[i].Handle.Dispose();
            for (int i = ancestors.Count - 1; i >= 0; i--) ancestors[i].Dispose();
            throw;
        }

        void PinAncestor(string path)
        {
            SafeFileHandle handle = InstallNative.OpenDirectory(path, InstallNative.ReadAttributes, FileShare.ReadWrite);
            try { InstallNative.ValidateDirectory(handle, path); if (BootstrapNative.IsCaseSensitive(handle)) throw new BootstrapInstallerException("Case-sensitive uninstall ancestor is forbidden."); ancestors.Add(handle); } catch { handle.Dispose(); throw; }
        }
        void CaptureTree(string directory)
        {
            Capture(directory, true);
            foreach (string child in Directory.EnumerateFileSystemEntries(directory).OrderBy(static path => Path.GetFileName(path), StringComparer.OrdinalIgnoreCase))
            {
                FileAttributes attributes = File.GetAttributes(child);
                if ((attributes & FileAttributes.ReparsePoint) != 0) throw new BootstrapInstallerException("Owned uninstall tree contains a reparse point.");
                if ((attributes & FileAttributes.Directory) != 0) CaptureTree(child); else Capture(child, false);
            }
        }
        void Capture(string path, bool directory)
        {
            string full = InstallNative.Normalize(path); if (!InstallNative.IsStrictlyContained(root, full)) throw new BootstrapInstallerException("Owned uninstall tree escaped root.");
            SafeFileHandle handle = OpenOwned(full, directory);
            try
            {
                if (directory)
                {
                    InstallNative.ValidateDirectory(handle, full); if (BootstrapNative.IsCaseSensitive(handle)) throw new BootstrapInstallerException("Case-sensitive owned directory is forbidden.");
                    handles.Add(new(new(full, true, InstallNative.Identity(handle), -1, null, null), handle));
                }
                else
                {
                    InstallNative.ValidateFile(handle, full); (InstalledFileIdentity identity, long length, byte[] sha256) = CaptureFile(handle);
                    handles.Add(new(new(full, false, identity, length, sha256, null), handle));
                }
                handle = null!;
            }
            finally { handle?.Dispose(); }
        }
    }

    internal static SafeFileHandle OpenOwned(string path, bool directory, bool deleteAccess = true)
    {
        uint access = InstallNative.GenericRead | (deleteAccess ? InstallNative.Delete : 0);
        SafeFileHandle handle = directory
            ? InstallNative.OpenDirectory(path, access | InstallNative.ReadAttributes, FileShare.Read)
            : InstallNative.CreateFileW(path, access, FileShare.Read, IntPtr.Zero, FileMode.Open, InstallNative.OpenReparse, IntPtr.Zero);
        if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new BootstrapInstallerException("Owned uninstall object open failed.", new Win32Exception(error)); }
        return handle;
    }

    private static BootstrapOwnershipV1 ReadOwnership(SafeFileHandle handle)
    {
        InstalledFileIdentity identity = InstallNative.Identity(handle); long length = RandomAccess.GetLength(handle);
        if (length < 0 || length > 1024 * 1024) throw new BootstrapInstallerException("Ownership size is invalid.");
        using var borrowed = new SafeFileHandle(handle.DangerousGetHandle(), ownsHandle: false);
        using var stream = new FileStream(borrowed, FileAccess.Read, 131072, false);
        stream.Position = 0;
        byte[] bytes = new byte[(int)length]; int read = 0;
        while (read < bytes.Length) { int count = stream.Read(bytes, read, bytes.Length - read); if (count == 0) throw new EndOfStreamException(); read += count; }
        if (stream.ReadByte() != -1 || InstallNative.Identity(handle) != identity || RandomAccess.GetLength(handle) != length) throw new BootstrapInstallerException("Ownership changed while reading.");
        try { return BootstrapInstallerCore.ParseOwnership(new UTF8Encoding(false, true).GetString(bytes)); }
        catch (Exception error) when (error is JsonException or DecoderFallbackException or InvalidOperationException or FormatException or OverflowException or KeyNotFoundException) { throw new BootstrapInstallerException("Ownership does not match strict schema 1.", error); }
    }

    internal static bool FileMatches(SafeFileHandle handle, InstalledFileIdentity identity, long length, byte[] sha256)
    {
        if (InstallNative.Identity(handle) != identity || RandomAccess.GetLength(handle) != length) return false;
        byte[] actual = HashFile(handle);
        return InstallNative.Identity(handle) == identity && RandomAccess.GetLength(handle) == length && CryptographicOperations.FixedTimeEquals(actual, sha256);
    }

    internal static byte[] TopDirectoryFingerprint(SafeFileHandle handle, string path)
    {
        InstallNative.ValidateDirectory(handle, path);
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (string child in Directory.EnumerateFileSystemEntries(path).OrderBy(static value => Path.GetFileName(value), StringComparer.OrdinalIgnoreCase))
        {
            FileAttributes attributes = File.GetAttributes(child); if ((attributes & FileAttributes.ReparsePoint) != 0) throw new BootstrapInstallerException("Owned uninstall directory contains a reparse point."); bool directory = (attributes & FileAttributes.Directory) != 0;
            byte[] name = Encoding.UTF8.GetBytes(Path.GetFileName(child).ToUpperInvariant()); hash.AppendData([directory ? (byte)1 : (byte)0]); hash.AppendData(BitConverter.GetBytes(name.Length)); hash.AppendData(name);
        }
        InstallNative.ValidateDirectory(handle, path); return hash.GetHashAndReset();
    }

    private static (InstalledFileIdentity Identity, long Length, byte[] Sha256) CaptureFile(SafeFileHandle handle)
    {
        InstalledFileIdentity identity = InstallNative.Identity(handle); long length = RandomAccess.GetLength(handle); byte[] sha256 = HashFile(handle); if (InstallNative.Identity(handle) != identity || RandomAccess.GetLength(handle) != length) throw new BootstrapInstallerException("Owned uninstall file changed while recording."); return (identity, length, sha256);
    }

    private static byte[] HashFile(SafeFileHandle handle)
    {
        using var borrowed = new SafeFileHandle(handle.DangerousGetHandle(), ownsHandle: false); using var stream = new FileStream(borrowed, FileAccess.Read, 131072, false); stream.Position = 0; return SHA256.HashData(stream);
    }
}

internal static class BootstrapNative
{
    private const int FileRenameInfo = 3;
    [StructLayout(LayoutKind.Sequential)] private struct CaseInfo { internal uint Flags; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out CaseInfo info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, IntPtr info, uint size);
    internal static bool IsCaseSensitive(SafeFileHandle handle) => GetFileInformationByHandleEx(handle, 23, out CaseInfo info, (uint)Marshal.SizeOf<CaseInfo>()) && (info.Flags & 1) != 0;
    internal static void RenameByHandle(SafeFileHandle handle, string target, bool replace)
    {
        byte[] name = Encoding.Unicode.GetBytes(Path.GetFullPath(target)); int rootOffset = IntPtr.Size == 8 ? 8 : 4, lengthOffset = IntPtr.Size == 8 ? 16 : 8, nameOffset = IntPtr.Size == 8 ? 20 : 12, bufferLength = checked(nameOffset + name.Length + sizeof(char)); IntPtr buffer = Marshal.AllocHGlobal(bufferLength);
        try { for (int i = 0; i < bufferLength; i++) Marshal.WriteByte(buffer, i, 0); Marshal.WriteInt32(buffer, 0, replace ? 1 : 0); Marshal.WriteIntPtr(buffer, rootOffset, IntPtr.Zero); Marshal.WriteInt32(buffer, lengthOffset, name.Length); Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length); if (!SetFileInformationByHandle(handle, FileRenameInfo, buffer, checked((uint)bufferLength))) throw new BootstrapInstallerException("Handle rename failed.", new Win32Exception(Marshal.GetLastWin32Error())); }
        finally { Marshal.FreeHGlobal(buffer); }
    }
}
