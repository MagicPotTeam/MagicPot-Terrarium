using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace MagicPot.Launcher;

internal class ArtifactDownloaderException : Exception
{
    public ArtifactDownloaderException(string message) : base(message) { }
    public ArtifactDownloaderException(string message, Exception innerException) : base(message, innerException) { }
}

internal sealed class ArtifactTransportException : ArtifactDownloaderException
{
    public ArtifactTransportException(string message, Exception innerException) : base(message, innerException) { }
}

internal sealed class ArtifactDownloadIdentity
{
    internal ArtifactDownloadIdentity(string configIdentity, string manifestRawDigest, string signingPayloadDigest, string signatureKeyId, string verifierIdentity, string channel, string generatedAt, string kind, string platform, string arch, string url, string sha256, long size, long unpackedSize, string entrypoint, string createdAt, string? version, string? buildId, string? commitSha, string runtimeId)
    {
        ConfigIdentity = configIdentity;
        ManifestRawDigest = manifestRawDigest;
        SigningPayloadDigest = signingPayloadDigest;
        SignatureKeyId = signatureKeyId;
        VerifierIdentity = verifierIdentity;
        Channel = channel;
        GeneratedAt = generatedAt;
        Kind = kind;
        Platform = platform;
        Arch = arch;
        Url = url;
        Sha256 = sha256;
        Size = size;
        UnpackedSize = unpackedSize;
        Entrypoint = entrypoint;
        CreatedAt = createdAt;
        Version = version;
        BuildId = buildId;
        CommitSha = commitSha;
        RuntimeId = runtimeId;
    }

    public string ConfigIdentity { get; }
    public string ManifestRawDigest { get; }
    public string SigningPayloadDigest { get; }
    public string SignatureKeyId { get; }
    public string VerifierIdentity { get; }
    public string Channel { get; }
    public string GeneratedAt { get; }
    public string Kind { get; }
    public string Platform { get; }
    public string Arch { get; }
    public string Url { get; }
    public string Sha256 { get; }
    public long Size { get; }
    public long UnpackedSize { get; }
    public string Entrypoint { get; }
    public string CreatedAt { get; }
    public string? Version { get; }
    public string? BuildId { get; }
    public string? CommitSha { get; }
    public string RuntimeId { get; }
}

internal sealed class ArtifactDownloadOptions
{
    public required string StateRoot { get; init; }
    [Obsolete("Ignored: download identity is derived from the verified manifest proof and downloader build identity.")]
    public string? ConfigIdentity { get; init; }
    public IReadOnlyList<TrustedReleaseSource>? TrustedSources { get; init; }
    public TimeSpan Timeout { get; init; } = TimeSpan.FromMinutes(5);
    public TimeSpan LockTimeout { get; init; } = TimeSpan.FromMinutes(5);
    public TimeSpan LockRetryDelay { get; init; } = TimeSpan.FromMilliseconds(50);
    public long? MaxBytes { get; init; }
    public Func<DateTimeOffset>? Clock { get; init; }
    public Func<string>? UniqueId { get; init; }
}

internal sealed class VerifiedArtifactLease : IDisposable, IAsyncDisposable
{
    private Stream? stream;

    internal VerifiedArtifactLease(string path, long length, string sha256, string kind, ArtifactDownloadIdentity identity, bool cacheHit, Stream stream)
    {
        Path = path;
        Length = length;
        Sha256 = sha256;
        Kind = kind;
        Identity = identity;
        ManifestRawDigest = identity.ManifestRawDigest;
        SigningPayloadDigest = identity.SigningPayloadDigest;
        SignatureKeyId = identity.SignatureKeyId;
        VerifierIdentity = identity.VerifierIdentity;
        Channel = identity.Channel;
        GeneratedAt = identity.GeneratedAt;
        CacheHit = cacheHit;
        this.stream = stream;
    }

    // Path is diagnostic only. Consumers must use Stream: reopening Path is not a verified operation.
    public string Path { get; }
    public long Length { get; }
    public string Sha256 { get; }
    public string ManifestRawDigest { get; }
    public string SigningPayloadDigest { get; }
    public string SignatureKeyId { get; }
    public string VerifierIdentity { get; }
    public string Channel { get; }
    public string GeneratedAt { get; }
    public string Kind { get; }
    public ArtifactDownloadIdentity Identity { get; }
    public bool CacheHit { get; }
    public Stream Stream => Volatile.Read(ref stream) ?? throw new ObjectDisposedException(nameof(VerifiedArtifactLease));
    public Stream OpenReadOnlyStream => Stream;

    public void Dispose() => Interlocked.Exchange(ref stream, null)?.Dispose();
    public async ValueTask DisposeAsync()
    {
        var value = Interlocked.Exchange(ref stream, null);
        if (value is not null) await value.DisposeAsync().ConfigureAwait(false);
    }
}

internal sealed class ArtifactDownloader : IDisposable
{
    public const long GlobalMaxBytes = 2L * 1024L * 1024L * 1024L;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly HashSet<string> AllowedExtensions = new(StringComparer.OrdinalIgnoreCase) { ".zip", ".7z", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".msi", ".exe" };
    private readonly string downloadsRoot;
    private readonly string configIdentity;
    private readonly IReadOnlyList<TrustedReleaseSource> trustedSources;
    private readonly TimeSpan timeout;
    private readonly TimeSpan lockTimeout;
    private readonly TimeSpan lockRetryDelay;
    private readonly long? configuredMaxBytes;
    private readonly Func<DateTimeOffset> clock;
    private readonly Func<string> uniqueId;
    private readonly IChannelManifestTransport transport;
    private readonly bool ownsTransport;
    private readonly FileIdentity? rootIdentity;

    internal ArtifactDownloader(ArtifactDownloadOptions options) : this(options, new DefaultChannelManifestTransport(), true) { }

    [EditorBrowsable(EditorBrowsableState.Never)]
    internal ArtifactDownloader(ArtifactDownloadOptions options, IChannelManifestTransport transport, bool disposeTransport = false)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("ArtifactDownloader requires Windows file identity and safe-open semantics.");
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(transport);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.StateRoot);
        if (!Path.IsPathFullyQualified(options.StateRoot)) throw new ArgumentException("StateRoot must be absolute.", nameof(options));
        if (options.Timeout <= TimeSpan.Zero && options.Timeout != Timeout.InfiniteTimeSpan) throw new ArgumentOutOfRangeException(nameof(options));
        if (options.LockTimeout <= TimeSpan.Zero && options.LockTimeout != Timeout.InfiniteTimeSpan) throw new ArgumentOutOfRangeException(nameof(options));
        if (options.LockRetryDelay <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(options));
        if (options.MaxBytes is <= 0 or > GlobalMaxBytes) throw new ArgumentOutOfRangeException(nameof(options), "MaxBytes must be positive and no greater than 2 GiB.");
        var stateRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(options.StateRoot));
        ValidatePathSegments(stateRoot, true); Directory.CreateDirectory(stateRoot); ValidatePathSegments(stateRoot, false);
        downloadsRoot = Path.Combine(stateRoot, "downloads");
        ValidatePathSegments(downloadsRoot, true); Directory.CreateDirectory(downloadsRoot); ValidatePathSegments(downloadsRoot, false);
        rootIdentity = GetIdentity(downloadsRoot, true, false);
        configIdentity = "artifact-downloader:v4";
        trustedSources = options.TrustedSources ?? OfflineUpdateDecision.DefaultTrustedReleaseSources;
        timeout = options.Timeout; lockTimeout = options.LockTimeout; lockRetryDelay = options.LockRetryDelay;
        configuredMaxBytes = options.MaxBytes;
        clock = options.Clock ?? (static () => DateTimeOffset.UtcNow);
        uniqueId = options.UniqueId ?? (static () => Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture));
        this.transport = transport; ownsTransport = disposeTransport;
    }

    internal Task<VerifiedArtifactLease> DownloadAsync(VerifiedArtifactRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        return DownloadCoreAsync(request.Artifact, DeriveIdentity(request), cancellationToken);
    }
    public void Dispose() { if (ownsTransport) transport.Dispose(); }

    private async Task<VerifiedArtifactLease> DownloadCoreAsync(ArtifactV1 artifact, ArtifactDownloadIdentity identity, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(artifact);
        var descriptor = ValidateArtifact(artifact, identity);
        using var mutex = await DedicatedMutexLease.AcquireAsync(descriptor.MutexName, lockTimeout, lockRetryDelay, cancellationToken).ConfigureAwait(false);
        await using var fileLock = await AcquireFileLockAsync(descriptor.LockPath, cancellationToken).ConfigureAwait(false);
        ValidateRoot();
        if (File.Exists(descriptor.FinalPath))
        {
            var hasMetadata = PrepareExistingMetadata(descriptor);
            var cached = await TryOpenVerifiedAsync(descriptor, cancellationToken).ConfigureAwait(false);
            if (cached is not null)
            {
                try { if (!hasMetadata) EnsureMetadata(descriptor); return CreateLease(descriptor, cached, true); }
                catch { cached.Dispose(); throw; }
            }
            Quarantine(descriptor.FinalPath, descriptor.Extension, "artifact");
            if (hasMetadata && File.Exists(descriptor.MetadataPath)) Quarantine(descriptor.MetadataPath, ".json", "metadata");
        }
        else if (File.Exists(descriptor.MetadataPath))
        {
            PrepareExistingMetadata(descriptor);
            Quarantine(descriptor.MetadataPath, ".json", "orphan metadata");
        }

        var partialPath = Child("." + descriptor.CacheKey + "." + SafeUniqueId() + ".partial");
        FileStream? partial = null; var published = false;
        try
        {
            partial = await DownloadToPartialAsync(descriptor, partialPath, cancellationToken).ConfigureAwait(false);
            var partialIdentity = GetIdentity(partial.SafeFileHandle, false, true);
            ValidateRoot();
            try { File.Move(partialPath, descriptor.FinalPath); published = true; }
            catch (IOException) when (File.Exists(descriptor.FinalPath))
            {
                partial.Dispose(); partial = null; BestEffortDelete(partialPath);
                var concurrent = await TryOpenVerifiedAsync(descriptor, cancellationToken).ConfigureAwait(false);
                if (concurrent is null) throw new ArtifactDownloaderException("A concurrent final artifact failed validation.");
                try { EnsureMetadata(descriptor); return CreateLease(descriptor, concurrent, true); }
                catch { concurrent.Dispose(); throw; }
            }
            ValidateRoot();
            var finalIdentity = GetIdentity(descriptor.FinalPath, false, true);
            if (partialIdentity is not null && finalIdentity != partialIdentity) throw new ArtifactDownloaderException("Final artifact identity changed during publication.");
            EnsureMetadata(descriptor);
            partial.Position = 0;
            var lease = CreateLease(descriptor, partial, false); partial = null; return lease;
        }
        catch
        {
            partial?.Dispose();
            BestEffortDelete(partialPath);
            if (published) BestEffortDelete(descriptor.FinalPath);
            throw;
        }
        finally { partial?.Dispose(); BestEffortDelete(partialPath); }
    }

    private static VerifiedArtifactLease CreateLease(Descriptor descriptor, FileStream stream, bool cacheHit) => new(descriptor.FinalPath, descriptor.Artifact.Size, descriptor.Sha256, descriptor.Artifact.Kind, descriptor.Identity, cacheHit, new ReadOnlyStream(stream));

    private Descriptor ValidateArtifact(ArtifactV1 artifact, ArtifactDownloadIdentity identity)
    {
        if (artifact is not AppArtifactV1 and not RuntimeArtifactV1) throw new ArgumentException("Only AppArtifactV1 or RuntimeArtifactV1 is accepted.", nameof(artifact));
        if (!Uri.TryCreate(artifact.Url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Fragment)) throw new ArtifactDownloaderException("Artifact URL must be absolute HTTPS without credentials or fragment.");
        if (!IsTrusted(uri)) throw new ArtifactDownloaderException("Artifact URL is outside configured trusted release sources.");
        if (artifact.Size <= 0 || artifact.Size > GlobalMaxBytes) throw new ArtifactDownloaderException("Artifact size is outside downloader limits.");
        var maxBytes = configuredMaxBytes ?? artifact.Size;
        if (artifact.Size > maxBytes) throw new ArtifactDownloaderException("Artifact size exceeds MaxBytes.");
        if (artifact.Sha256.Length != 64 || artifact.Sha256.Any(static c => !Uri.IsHexDigit(c))) throw new ArtifactDownloaderException("Artifact SHA-256 is invalid.");
        var sha = artifact.Sha256.ToLowerInvariant(); var extension = Extension(uri);
        if (identity.Url != uri.AbsoluteUri || identity.Sha256 != sha || identity.Size != artifact.Size) throw new ArtifactDownloaderException("Derived artifact identity does not match the validated artifact.");
        var canonicalIdentity = SerializeCanonicalIdentity(identity);
        var cacheKey = Convert.ToHexString(SHA256.HashData(StrictUtf8.GetBytes(canonicalIdentity))).ToLowerInvariant();
        return new Descriptor(artifact, identity, uri, sha, canonicalIdentity, cacheKey, extension,
            Child(cacheKey + extension), Child(cacheKey + extension + ".metadata.json"), Child(cacheKey + ".lock"),
            "MagicPot.Artifact." + Convert.ToHexString(SHA256.HashData(StrictUtf8.GetBytes(downloadsRoot + "\n" + cacheKey))), maxBytes);
    }

    private ArtifactDownloadIdentity DeriveIdentity(VerifiedArtifactRequest request)
    {
        var artifact = request.Artifact;
        var proof = request.Proof;
        var app = artifact as AppArtifactV1;
        var runtimeId = app?.RuntimeId ?? ((RuntimeArtifactV1)artifact).RuntimeId;
        return new(configIdentity, proof.RawManifestSha256, proof.SigningPayloadSha256, proof.SignatureKeyId, proof.VerifierIdentity, proof.Channel, proof.GeneratedAt,
            artifact.Kind, artifact.Platform, artifact.Arch, NormalizeUrl(artifact.Url), artifact.Sha256.ToLowerInvariant(), artifact.Size, artifact.UnpackedSize,
            artifact is AppArtifactV1 appArtifact ? appArtifact.Entrypoint : ((RuntimeArtifactV1)artifact).Entrypoint, artifact.CreatedAt,
            app?.Version, app?.BuildId, app?.CommitSha, runtimeId);
    }
    private static string NormalizeUrl(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.AbsoluteUri : url;

    private static string SerializeCanonicalIdentity(ArtifactDownloadIdentity identity)
    {
        using var memory = new MemoryStream();
        using (var writer = new Utf8JsonWriter(memory, new JsonWriterOptions { Indented = false }))
        {
            writer.WriteStartObject();
            writer.WriteString("configIdentity", identity.ConfigIdentity);
            writer.WriteString("manifestRawDigest", identity.ManifestRawDigest);
            writer.WriteString("signingPayloadDigest", identity.SigningPayloadDigest);
            writer.WriteString("signatureKeyId", identity.SignatureKeyId);
            writer.WriteString("verifierIdentity", identity.VerifierIdentity);
            writer.WriteString("channel", identity.Channel);
            writer.WriteString("generatedAt", identity.GeneratedAt);
            writer.WriteString("kind", identity.Kind);
            writer.WriteString("platform", identity.Platform);
            writer.WriteString("arch", identity.Arch);
            writer.WriteString("url", identity.Url);
            writer.WriteString("sha256", identity.Sha256);
            writer.WriteNumber("size", identity.Size);
            writer.WriteNumber("unpackedSize", identity.UnpackedSize);
            writer.WriteString("entrypoint", identity.Entrypoint);
            writer.WriteString("createdAt", identity.CreatedAt);
            if (identity.Version is null) writer.WriteNull("version"); else writer.WriteString("version", identity.Version);
            if (identity.BuildId is null) writer.WriteNull("buildId"); else writer.WriteString("buildId", identity.BuildId);
            if (identity.CommitSha is null) writer.WriteNull("commitSha"); else writer.WriteString("commitSha", identity.CommitSha);
            writer.WriteString("runtimeId", identity.RuntimeId);
            writer.WriteEndObject();
        }
        return StrictUtf8.GetString(memory.ToArray());
    }

    private bool IsTrusted(Uri uri)
    {
        foreach (var source in trustedSources)
        {
            if (!Uri.TryCreate(source.Origin, UriKind.Absolute, out var origin)) continue;
            if (!string.Equals(uri.Scheme, origin.Scheme, StringComparison.OrdinalIgnoreCase) || !string.Equals(uri.Host, origin.Host, StringComparison.OrdinalIgnoreCase) || uri.Port != origin.Port) continue;
            var prefix = source.RepoPathPrefix.TrimEnd('/');
            if (uri.AbsolutePath.Equals(prefix, StringComparison.Ordinal) || uri.AbsolutePath.StartsWith(prefix + "/", StringComparison.Ordinal)) return true;
        }
        return false;
    }

    private async Task<FileStream> DownloadToPartialAsync(Descriptor descriptor, string partialPath, CancellationToken callerToken)
    {
        ValidateRoot(); using var request = new HttpRequestMessage(HttpMethod.Get, descriptor.Uri);
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(callerToken); if (timeout != Timeout.InfiniteTimeSpan) timeoutSource.CancelAfter(timeout);
        HttpResponseMessage response;
        try { response = await transport.SendAsync(request, timeoutSource.Token).ConfigureAwait(false); }
        catch (Exception exception) when (exception is HttpRequestException or IOException || (exception is OperationCanceledException && !callerToken.IsCancellationRequested)) { throw new ArtifactTransportException("Artifact request transport failed.", exception); }
        using (response)
        {
            var finalUri = response.RequestMessage?.RequestUri;
            if (finalUri is null || !string.Equals(finalUri.AbsoluteUri, descriptor.Uri.AbsoluteUri, StringComparison.Ordinal)) throw new ArtifactDownloaderException("Artifact redirect/final URL mismatch.");
            var status = (int)response.StatusCode;
            if (status is >= 300 and <= 399) throw new ArtifactDownloaderException("Artifact redirects are forbidden.");
            if (response.StatusCode != HttpStatusCode.OK) throw new ArtifactDownloaderException("Unexpected artifact HTTP status " + status.ToString(CultureInfo.InvariantCulture) + ".");
            var length = response.Content.Headers.ContentLength;
            if (length is not null && (length != descriptor.Artifact.Size || length > descriptor.MaxBytes)) throw new ArtifactDownloaderException("Artifact Content-Length does not match manifest size.");
            FileStream? output = null;
            try
            {
                await using var body = await response.Content.ReadAsStreamAsync(timeoutSource.Token).ConfigureAwait(false);
                output = OpenNewPartial(partialPath);
                var initialIdentity = GetIdentity(output.SafeFileHandle, false, true);
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256); var buffer = new byte[131072]; long total = 0;
                while (true)
                {
                    var count = await body.ReadAsync(buffer.AsMemory(), timeoutSource.Token).ConfigureAwait(false); if (count == 0) break;
                    total = checked(total + count); if (total > descriptor.Artifact.Size || total > descriptor.MaxBytes) throw new ArtifactDownloaderException("Artifact stream exceeded its exact size limit.");
                    hash.AppendData(buffer, 0, count); await output.WriteAsync(buffer.AsMemory(0, count), timeoutSource.Token).ConfigureAwait(false);
                }
                if (total != descriptor.Artifact.Size) throw new ArtifactDownloaderException("Artifact stream ended short.");
                if (!CryptographicOperations.FixedTimeEquals(hash.GetHashAndReset(), Convert.FromHexString(descriptor.Sha256))) throw new ArtifactDownloaderException("Artifact SHA-256 mismatch.");
                await output.FlushAsync(timeoutSource.Token).ConfigureAwait(false); output.Flush(true);
                if (output.Length != descriptor.Artifact.Size || initialIdentity is not null && GetIdentity(output.SafeFileHandle, false, true) != initialIdentity) throw new ArtifactDownloaderException("Partial artifact identity or size changed while open.");
                output.Position = 0; var result = output; output = null; return result;
            }
            catch (Exception exception) when (exception is IOException or HttpRequestException) { throw new ArtifactTransportException("Artifact response body transport failed.", exception); }
            catch (OperationCanceledException exception) when (!callerToken.IsCancellationRequested) { throw new ArtifactTransportException("Artifact response body timed out.", exception); }
            finally { output?.Dispose(); }
        }
    }

    private async Task<FileStream?> TryOpenVerifiedAsync(Descriptor descriptor, CancellationToken cancellationToken)
    {
        ValidateRoot(); FileStream? stream = null;
        try
        {
            stream = OpenExclusiveRead(descriptor.FinalPath); if (stream.Length != descriptor.Artifact.Size) { stream.Dispose(); return null; }
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256); var buffer = new byte[131072];
            while (true) { var count = await stream.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false); if (count == 0) break; hash.AppendData(buffer, 0, count); }
            if (!CryptographicOperations.FixedTimeEquals(hash.GetHashAndReset(), Convert.FromHexString(descriptor.Sha256))) { stream.Dispose(); return null; }
            stream.Position = 0; return stream;
        }
        catch (FileNotFoundException) { stream?.Dispose(); return null; }
        catch (DirectoryNotFoundException) { stream?.Dispose(); return null; }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { stream?.Dispose(); throw new ArtifactDownloaderException("Cached artifact could not be opened safely.", exception); }
    }

    private FileStream OpenExclusiveRead(string path)
    {
        var handle = CreateFileW(path, GenericRead, FileShare.Read, IntPtr.Zero, FileMode.Open, FileFlagsAndAttributes.FileAttributeNormal | FileFlagsAndAttributes.FileFlagOpenReparsePoint | FileFlagsAndAttributes.FileFlagSequentialScan, IntPtr.Zero);
        if (handle.IsInvalid) { var error = Marshal.GetLastWin32Error(); handle.Dispose(); if (error is ErrorFileNotFound or ErrorPathNotFound) throw new FileNotFoundException(null, path); throw new IOException("Safe cache open failed.", new Win32Exception(error)); }
        try { _ = GetIdentity(handle, false, true); return new FileStream(handle, FileAccess.Read, 131072, false); } catch { handle.Dispose(); throw; }
    }

    private static FileStream OpenNewPartial(string path)
    {
        var handle = CreateFileW(path, GenericRead | GenericWrite, FileShare.Read | FileShare.Delete, IntPtr.Zero, FileMode.CreateNew, FileFlagsAndAttributes.FileAttributeNormal | FileFlagsAndAttributes.FileFlagOpenReparsePoint | FileFlagsAndAttributes.FileFlagSequentialScan | FileFlagsAndAttributes.FileFlagWriteThrough, IntPtr.Zero);
        if (handle.IsInvalid) { var error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new IOException("Safe partial create failed.", new Win32Exception(error)); }
        try { _ = GetIdentity(handle, false, true); return new FileStream(handle, FileAccess.ReadWrite, 131072, false); } catch { handle.Dispose(); throw; }
    }

    private bool PrepareExistingMetadata(Descriptor descriptor)
    {
        if (!File.Exists(descriptor.MetadataPath)) return false;
        try { ValidateMetadata(descriptor); return true; }
        catch (MetadataCorruptException exception) { Quarantine(descriptor.MetadataPath, ".json", "metadata", exception); return false; }
    }

    private void EnsureMetadata(Descriptor descriptor)
    {
        if (PrepareExistingMetadata(descriptor)) return;
        AtomicWrite(descriptor.MetadataPath, SerializeMetadata(descriptor));
    }

    private void ValidateMetadata(Descriptor descriptor)
    {
        try
        {
            using var stream = OpenExclusiveRead(descriptor.MetadataPath); using var document = JsonDocument.Parse(stream); var root = document.RootElement;
            var allowed = new HashSet<string>(["schema", "cacheKey", "configIdentity", "manifestRawDigest", "signingPayloadDigest", "signatureKeyId", "verifierIdentity", "channel", "generatedAt", "kind", "platform", "arch", "url", "sha256", "size", "unpackedSize", "entrypoint", "createdAt", "version", "buildId", "commitSha", "runtimeId", "verifiedAt"], StringComparer.Ordinal);
            if (root.ValueKind != JsonValueKind.Object) throw new MetadataCorruptException("Metadata root is not an object.");
            var names = root.EnumerateObject().Select(static p => p.Name).ToArray();
            if (names.Length != allowed.Count || names.Distinct(StringComparer.Ordinal).Count() != names.Length || names.Any(name => !allowed.Contains(name)) || allowed.Any(name => !names.Contains(name, StringComparer.Ordinal))) throw new MetadataCorruptException("Metadata shape is invalid.");
            var schema = RequiredInt32(root, "schema");
            var cacheKey = RequiredString(root, "cacheKey");
            var config = RequiredString(root, "configIdentity");
            var manifestRawDigest = RequiredString(root, "manifestRawDigest");
            var signingPayloadDigest = RequiredString(root, "signingPayloadDigest");
            var signatureKeyId = RequiredString(root, "signatureKeyId");
            var verifierIdentity = RequiredString(root, "verifierIdentity");
            var channel = RequiredString(root, "channel");
            var generatedAt = RequiredString(root, "generatedAt");
            var kind = RequiredString(root, "kind");
            var platform = RequiredString(root, "platform");
            var arch = RequiredString(root, "arch");
            var url = RequiredString(root, "url");
            var sha256 = RequiredString(root, "sha256");
            var size = RequiredInt64(root, "size");
            var unpackedSize = RequiredInt64(root, "unpackedSize");
            var entrypoint = RequiredString(root, "entrypoint");
            var createdAt = RequiredString(root, "createdAt");
            var version = NullableString(root, "version");
            var buildId = NullableString(root, "buildId");
            var commitSha = NullableString(root, "commitSha");
            var runtimeId = RequiredString(root, "runtimeId");
            var verifiedAt = RequiredString(root, "verifiedAt");
            if (!DateTimeOffset.TryParseExact(verifiedAt, "O", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out _)) throw new MetadataCorruptException("Metadata verification timestamp is invalid.");
            var identity = descriptor.Identity;
            if (schema != 4 || cacheKey != descriptor.CacheKey || config != identity.ConfigIdentity || manifestRawDigest != identity.ManifestRawDigest || signingPayloadDigest != identity.SigningPayloadDigest || signatureKeyId != identity.SignatureKeyId || verifierIdentity != identity.VerifierIdentity || channel != identity.Channel || generatedAt != identity.GeneratedAt || kind != identity.Kind || platform != identity.Platform || arch != identity.Arch || url != identity.Url || sha256 != identity.Sha256 || size != identity.Size || unpackedSize != identity.UnpackedSize || entrypoint != identity.Entrypoint || createdAt != identity.CreatedAt || version != identity.Version || buildId != identity.BuildId || commitSha != identity.CommitSha || runtimeId != identity.RuntimeId) throw new ArtifactDownloaderException("Cache metadata identity conflict; refusing replacement.");
        }
        catch (MetadataCorruptException) { throw; }
        catch (ArtifactDownloaderException) { throw; }
        catch (Exception exception) when (exception is JsonException or InvalidOperationException or KeyNotFoundException or FormatException or IOException) { throw new MetadataCorruptException("Metadata is corrupt.", exception); }
    }

    private string SerializeMetadata(Descriptor d) => JsonSerializer.Serialize(new Dictionary<string, object?> { ["schema"] = 4, ["cacheKey"] = d.CacheKey, ["configIdentity"] = d.Identity.ConfigIdentity, ["manifestRawDigest"] = d.Identity.ManifestRawDigest, ["signingPayloadDigest"] = d.Identity.SigningPayloadDigest, ["signatureKeyId"] = d.Identity.SignatureKeyId, ["verifierIdentity"] = d.Identity.VerifierIdentity, ["channel"] = d.Identity.Channel, ["generatedAt"] = d.Identity.GeneratedAt, ["kind"] = d.Identity.Kind, ["platform"] = d.Identity.Platform, ["arch"] = d.Identity.Arch, ["url"] = d.Identity.Url, ["sha256"] = d.Identity.Sha256, ["size"] = d.Identity.Size, ["unpackedSize"] = d.Identity.UnpackedSize, ["entrypoint"] = d.Identity.Entrypoint, ["createdAt"] = d.Identity.CreatedAt, ["version"] = d.Identity.Version, ["buildId"] = d.Identity.BuildId, ["commitSha"] = d.Identity.CommitSha, ["runtimeId"] = d.Identity.RuntimeId, ["verifiedAt"] = clock().ToUniversalTime().ToString("O", CultureInfo.InvariantCulture) });
    private static string RequiredString(JsonElement root, string name) { var value = root.GetProperty(name); if (value.ValueKind != JsonValueKind.String) throw new MetadataCorruptException("Metadata property '" + name + "' is not a string."); return value.GetString()!; }
    private static string? NullableString(JsonElement root, string name) { var value = root.GetProperty(name); if (value.ValueKind == JsonValueKind.Null) return null; if (value.ValueKind != JsonValueKind.String) throw new MetadataCorruptException("Metadata property '" + name + "' is not a string or null."); return value.GetString(); }
    private static int RequiredInt32(JsonElement root, string name) { var value = root.GetProperty(name); if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt32(out var result)) throw new MetadataCorruptException("Metadata property '" + name + "' is not an integer."); return result; }
    private static long RequiredInt64(JsonElement root, string name) { var value = root.GetProperty(name); if (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var result)) throw new MetadataCorruptException("Metadata property '" + name + "' is not an integer."); return result; }

    private void AtomicWrite(string path, string text)
    {
        ValidateRoot();
        if (File.Exists(path)) _ = GetIdentity(path, false, true);
        var temporary = Child("." + Path.GetFileName(path) + "." + SafeUniqueId() + ".tmp");
        try
        {
            var bytes = StrictUtf8.GetBytes(text);
            FileIdentity? temporaryIdentity;
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                stream.Write(bytes);
                stream.Flush(true);
                temporaryIdentity = GetIdentity(stream.SafeFileHandle, false, true);
            }
            ValidateRoot();
            if (File.Exists(path)) File.Replace(temporary, path, null, true);
            else File.Move(temporary, path);
            var publishedIdentity = GetPublishedIdentity(path);
            if (temporaryIdentity is not null && publishedIdentity != temporaryIdentity) throw new ArtifactDownloaderException("Metadata identity changed during publication.");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            throw new ArtifactDownloaderException("Metadata atomic write failed.", exception);
        }
        finally { BestEffortDelete(temporary); }
    }

    private FileIdentity? GetPublishedIdentity(string path)
    {
        const int attempts = 5;
        for (var attempt = 0; attempt < attempts; attempt++)
        {
            ValidateRoot();
            using var handle = CreateFileW(path, 0, FileShare.ReadWrite | FileShare.Delete, IntPtr.Zero, FileMode.Open, FileFlagsAndAttributes.FileFlagOpenReparsePoint, IntPtr.Zero);
            if (!handle.IsInvalid) return GetIdentity(handle, false, true);
            var error = Marshal.GetLastWin32Error();
            if (error is not ErrorFileNotFound and not ErrorPathNotFound || attempt == attempts - 1)
                throw new ArtifactDownloaderException("State identity open failed.", new Win32Exception(error));
            Thread.Sleep(TimeSpan.FromMilliseconds(10));
        }
        throw new UnreachableException();
    }

    private void Quarantine(string path, string extension, string label, Exception? reason = null)
    {
        ValidateRoot(); _ = GetIdentity(path, false, true); var destination = Child(Path.GetFileNameWithoutExtension(path) + ".corrupt-" + SafeUniqueId() + extension);
        if (File.Exists(destination) || Directory.Exists(destination)) throw new ArtifactDownloaderException("Unsafe quarantine destination.", reason ?? new IOException());
        try { File.Move(path, destination); } catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { throw new ArtifactDownloaderException("Corrupt " + label + " could not be quarantined; refusing replacement.", exception); }
        ValidateRoot(); _ = GetIdentity(destination, false, true);
    }

    private async Task<FileStream> AcquireFileLockAsync(string path, CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested(); ValidateRoot();
            try
            {
                var handle = CreateFileW(path, GenericRead | GenericWrite, FileShare.None, IntPtr.Zero, FileMode.OpenOrCreate, FileFlagsAndAttributes.FileAttributeNormal | FileFlagsAndAttributes.FileFlagOpenReparsePoint | FileFlagsAndAttributes.FileFlagWriteThrough, IntPtr.Zero);
                if (handle.IsInvalid) { var error = Marshal.GetLastWin32Error(); handle.Dispose(); if (error is ErrorSharingViolation or ErrorLockViolation) throw new SharingViolationException(error); throw new ArtifactDownloaderException("Artifact lock safe open failed.", new Win32Exception(error)); }
                try { _ = GetIdentity(handle, false, true); if (!string.Equals(GetFinalPath(handle), path, StringComparison.OrdinalIgnoreCase)) throw new ArtifactDownloaderException("Artifact lock path mismatch."); return new FileStream(handle, FileAccess.ReadWrite, 1, false); } catch { handle.Dispose(); throw; }
            }
            catch (Exception exception) when (exception is SharingViolationException or IOException)
            {
                if (lockTimeout != Timeout.InfiniteTimeSpan && stopwatch.Elapsed >= lockTimeout) throw new ArtifactDownloaderException("Timed out acquiring artifact lock.", exception);
                await Task.Delay(NextDelay(stopwatch), cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private TimeSpan NextDelay(Stopwatch stopwatch) { var delay = lockRetryDelay; if (lockTimeout != Timeout.InfiniteTimeSpan) { var remaining = lockTimeout - stopwatch.Elapsed; if (remaining < delay) delay = remaining; } return delay > TimeSpan.Zero ? delay : TimeSpan.FromMilliseconds(1); }
    private void ValidateRoot() { ValidatePathSegments(downloadsRoot, false); var current = GetIdentity(downloadsRoot, true, false); if (rootIdentity is not null && current != rootIdentity) throw new ArtifactDownloaderException("Downloads root identity changed."); }
    private string Child(string name) { if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || name is "." or "..") throw new ArtifactDownloaderException("Unsafe downloader file name."); var path = Path.Combine(downloadsRoot, name); if (!string.Equals(Path.GetDirectoryName(path), downloadsRoot, StringComparison.OrdinalIgnoreCase)) throw new ArtifactDownloaderException("Downloader path escaped root."); return path; }
    private string SafeUniqueId() { var value = uniqueId(); if (string.IsNullOrWhiteSpace(value) || value.Length > 100 || value.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) throw new ArtifactDownloaderException("UniqueId returned unsafe value."); return value; }
    private static string Extension(Uri uri) { var extension = Path.GetExtension(Uri.UnescapeDataString(uri.AbsolutePath)); return AllowedExtensions.Contains(extension) ? extension.ToLowerInvariant() : ".bin"; }
    private static void BestEffortDelete(string path) { try { File.Delete(path); } catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { Debug.WriteLine("Best-effort partial cleanup failed: " + exception); } }

    private static void ValidatePathSegments(string path, bool allowMissingLeaf)
    {
        var full = Path.GetFullPath(path); var root = Path.GetPathRoot(full) ?? throw new ArtifactDownloaderException("State path has no filesystem root."); var current = root;
        foreach (var part in full[root.Length..].Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)) { if (part.Length == 0) continue; current = Path.Combine(current, part); if (!File.Exists(current) && !Directory.Exists(current)) { if (allowMissingLeaf && string.Equals(current, full, StringComparison.OrdinalIgnoreCase)) return; continue; } if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new ArtifactDownloaderException("Downloader paths must not traverse reparse points."); }
    }

    private static FileIdentity? GetIdentity(string path, bool directory, bool rejectMultipleLinks)
    {
        using var handle = CreateFileW(path, 0, FileShare.ReadWrite | FileShare.Delete, IntPtr.Zero, FileMode.Open, FileFlagsAndAttributes.FileFlagOpenReparsePoint | (directory ? FileFlagsAndAttributes.FileFlagBackupSemantics : 0), IntPtr.Zero);
        if (handle.IsInvalid) throw new ArtifactDownloaderException("State identity open failed.", new Win32Exception(Marshal.GetLastWin32Error())); return GetIdentity(handle, directory, rejectMultipleLinks);
    }

    private static FileIdentity? GetIdentity(SafeFileHandle handle, bool directory, bool rejectMultipleLinks)
    {
        if (!GetFileInformationByHandle(handle, out var info)) throw new ArtifactDownloaderException("State identity read failed.", new Win32Exception(Marshal.GetLastWin32Error())); var attributes = (FileAttributes)info.FileAttributes;
        if ((attributes & FileAttributes.ReparsePoint) != 0 || directory != ((attributes & FileAttributes.Directory) != 0)) throw new ArtifactDownloaderException("State object type/reparse status invalid."); if (!directory && rejectMultipleLinks && info.NumberOfLinks != 1) throw new ArtifactDownloaderException("Downloader files must have exactly one hard link."); return new FileIdentity(info.VolumeSerialNumber, ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow);
    }

    private static string GetFinalPath(SafeFileHandle handle)
    {
        var capacity = 512; while (true) { var builder = new StringBuilder(capacity); var length = GetFinalPathNameByHandleW(handle, builder, (uint)builder.Capacity, 0); if (length == 0) throw new ArtifactDownloaderException("Lock final path read failed.", new Win32Exception(Marshal.GetLastWin32Error())); if (length < builder.Capacity) { var path = builder.ToString(); if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + path[8..]; return path.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase) ? path[4..] : path; } capacity = checked((int)length + 1); }
    }

    private sealed class DedicatedMutexLease : IDisposable
    {
        private readonly ManualResetEventSlim release = new(false); private readonly TaskCompletionSource<DedicatedMutexLease> acquired = new(TaskCreationOptions.RunContinuationsAsynchronously); private readonly Thread thread; private readonly string name; private readonly TimeSpan timeout; private readonly TimeSpan retry; private readonly CancellationToken token; private CancellationTokenRegistration registration; private int disposed;
        private DedicatedMutexLease(string name, TimeSpan timeout, TimeSpan retry, CancellationToken token) { this.name = name; this.timeout = timeout; this.retry = retry; this.token = token; thread = new Thread(Run) { IsBackground = true, Name = "MagicPot artifact mutex" }; }
        public static Task<DedicatedMutexLease> AcquireAsync(string name, TimeSpan timeout, TimeSpan retry, CancellationToken token) { token.ThrowIfCancellationRequested(); var lease = new DedicatedMutexLease(name, timeout, retry, token); lease.registration = token.Register(static state => ((DedicatedMutexLease)state!).release.Set(), lease); lease.thread.Start(); return lease.acquired.Task; }
        private void Run() { using var mutex = new Mutex(false, name); var owns = false; try { var stopwatch = Stopwatch.StartNew(); while (!release.IsSet) { var wait = retry; if (timeout != Timeout.InfiniteTimeSpan) { var remaining = timeout - stopwatch.Elapsed; if (remaining <= TimeSpan.Zero) { acquired.TrySetException(new ArtifactDownloaderException("Timed out acquiring artifact named mutex.")); return; } if (remaining < wait) wait = remaining; } try { owns = mutex.WaitOne(wait); } catch (AbandonedMutexException) { owns = true; } if (!owns) continue; if (token.IsCancellationRequested) { acquired.TrySetCanceled(token); return; } registration.Dispose(); acquired.TrySetResult(this); release.Wait(); return; } acquired.TrySetCanceled(token); } catch (Exception exception) { acquired.TrySetException(exception); } finally { if (owns) mutex.ReleaseMutex(); } }
        public void Dispose() { if (Interlocked.Exchange(ref disposed, 1) != 0) return; release.Set(); if (!thread.Join(TimeSpan.FromSeconds(5))) Debug.WriteLine("Timed out releasing artifact named mutex."); registration.Dispose(); release.Dispose(); }
    }

    private sealed class ReadOnlyStream : Stream
    {
        private Stream? inner;
        public ReadOnlyStream(Stream inner) => this.inner = inner;
        private Stream Value => Volatile.Read(ref inner) ?? throw new ObjectDisposedException(nameof(ReadOnlyStream));
        public override bool CanRead => inner?.CanRead == true;
        public override bool CanSeek => inner?.CanSeek == true;
        public override bool CanWrite => false;
        public override long Length => Value.Length;
        public override long Position { get => Value.Position; set => Value.Position = value; }
        public override void Flush() { }
        public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public override int Read(byte[] buffer, int offset, int count) => Value.Read(buffer, offset, count);
        public override int Read(Span<byte> buffer) => Value.Read(buffer);
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => Value.ReadAsync(buffer, offset, count, cancellationToken);
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => Value.ReadAsync(buffer, cancellationToken);
        public override long Seek(long offset, SeekOrigin origin) => Value.Seek(offset, origin);
        public override void SetLength(long value) => throw new NotSupportedException("Verified artifact streams are read-only.");
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException("Verified artifact streams are read-only.");
        public override void Write(ReadOnlySpan<byte> buffer) => throw new NotSupportedException("Verified artifact streams are read-only.");
        protected override void Dispose(bool disposing) { if (disposing) Interlocked.Exchange(ref inner, null)?.Dispose(); base.Dispose(disposing); }
        public override async ValueTask DisposeAsync() { var value = Interlocked.Exchange(ref inner, null); if (value is not null) await value.DisposeAsync().ConfigureAwait(false); GC.SuppressFinalize(this); }
    }

    private sealed class MetadataCorruptException : Exception { public MetadataCorruptException(string message) : base(message) { } public MetadataCorruptException(string message, Exception innerException) : base(message, innerException) { } }
    private sealed class SharingViolationException(int error) : IOException("Sharing violation: " + error.ToString(CultureInfo.InvariantCulture));
    private sealed record Descriptor(ArtifactV1 Artifact, ArtifactDownloadIdentity Identity, Uri Uri, string Sha256, string CanonicalIdentity, string CacheKey, string Extension, string FinalPath, string MetadataPath, string LockPath, string MutexName, long MaxBytes);
    private readonly record struct FileIdentity(uint VolumeSerialNumber, ulong FileIndex);
    private const uint GenericRead = 0x80000000; private const uint GenericWrite = 0x40000000; private const int ErrorFileNotFound = 2; private const int ErrorPathNotFound = 3; private const int ErrorSharingViolation = 32; private const int ErrorLockViolation = 33;
    [Flags] private enum FileFlagsAndAttributes : uint { FileAttributeNormal = 0x00000080, FileFlagWriteThrough = 0x80000000, FileFlagSequentialScan = 0x08000000, FileFlagBackupSemantics = 0x02000000, FileFlagOpenReparsePoint = 0x00200000 }
    [StructLayout(LayoutKind.Sequential)] private struct ByHandleFileInformation { public uint FileAttributes; public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime; public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime; public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime; public uint VolumeSerialNumber; public uint FileSizeHigh; public uint FileSizeLow; public uint NumberOfLinks; public uint FileIndexHigh; public uint FileIndexLow; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)] private static extern SafeFileHandle CreateFileW(string fileName, uint desiredAccess, FileShare shareMode, IntPtr securityAttributes, FileMode creationDisposition, FileFlagsAndAttributes flagsAndAttributes, IntPtr templateFile);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out ByHandleFileInformation fileInformation);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder filePath, uint filePathLength, uint flags);
}
