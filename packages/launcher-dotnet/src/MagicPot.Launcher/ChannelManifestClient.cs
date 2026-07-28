using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace MagicPot.Launcher;

internal enum ChannelManifestFailureKind
{
    Unavailable,
    Failed
}

internal sealed class ChannelManifestClientException : Exception
{
    public ChannelManifestClientException(string message) : this(message, ChannelManifestFailureKind.Failed) { }
    public ChannelManifestClientException(string message, Exception innerException) : this(message, ChannelManifestFailureKind.Failed, innerException) { }
    public ChannelManifestClientException(string message, ChannelManifestFailureKind failureKind) : base(message) => FailureKind = failureKind;
    public ChannelManifestClientException(string message, ChannelManifestFailureKind failureKind, Exception innerException) : base(message, innerException) => FailureKind = failureKind;

    public ChannelManifestFailureKind FailureKind { get; }
}

internal sealed class ChannelManifestTransportException : Exception
{
    public ChannelManifestTransportException(string message, Exception innerException) : base(message, innerException) { }
}

internal interface IChannelManifestTransport : IDisposable
{
    Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken);
}

internal sealed class DefaultChannelManifestTransport : IChannelManifestTransport
{
    private readonly HttpClient client;

    public DefaultChannelManifestTransport()
    {
        var handler = new HttpClientHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            AutomaticDecompression = DecompressionMethods.None,
            Credentials = null,
            DefaultProxyCredentials = null,
            UseProxy = true
        };
        client = new HttpClient(handler, true);
    }

    public Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
        client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);

    public void Dispose() => client.Dispose();
}

internal sealed class ChannelManifestClientOptions
{
    public required string Url { get; init; }
    public required string Channel { get; init; }
    public required string StateRoot { get; init; }
    public required IChannelManifestSignatureVerifier SignatureVerifier { get; init; }
    [Obsolete("Ignored: configuration identity is derived from SignatureVerifier.VerifierIdentity.")]
    public string? KeySetIdentity { get; init; }
    public IReadOnlyList<TrustedReleaseSource>? TrustedSources { get; init; }
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(15);
    public TimeSpan StateLockTimeout { get; init; } = TimeSpan.FromSeconds(5);
    public TimeSpan StateLockRetryDelay { get; init; } = TimeSpan.FromMilliseconds(50);
    public long MaxResponseBytes { get; init; } = 2L * 1024L * 1024L;
    public Func<DateTimeOffset>? Now { get; init; }
    public Func<string>? UniqueId { get; init; }
}

internal sealed record ChannelManifestLoadResult(VerifiedChannelManifestProof Proof, string Source)
{
    public VerifiedChannelManifestProof VerifiedManifest => Proof;
}

internal sealed class ChannelManifestClient : IChannelManifestClient
{
    private const string CacheFileName = "cache.json";
    private const string HighWaterFileName = "high-water.json";
    private const string LockFileName = "update.lock";
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private readonly Uri url;
    private readonly string channel;
    private readonly string stateRoot;
    private readonly string cachePath;
    private readonly string highWaterPath;
    private readonly string stateLockPath;
    private readonly IChannelManifestSignatureVerifier verifier;
    private readonly IReadOnlyList<TrustedReleaseSource> trustedSources;
    private readonly IChannelManifestTransport transport;
    private readonly bool ownsTransport;
    private readonly TimeSpan timeout;
    private readonly TimeSpan stateLockTimeout;
    private readonly TimeSpan stateLockRetryDelay;
    private readonly long maxResponseBytes;
    private readonly Func<DateTimeOffset> now;
    private readonly Func<string> uniqueId;
    private readonly string configIdentity;
    private readonly string mutexName;
    private readonly FileIdentity? rootIdentity;

    internal ChannelManifestClient(ChannelManifestClientOptions options) : this(options, new DefaultChannelManifestTransport(), true) { }

    // Explicit test transport seam. Production callers should use the options-only constructor.
    [EditorBrowsable(EditorBrowsableState.Never)]
    internal ChannelManifestClient(ChannelManifestClientOptions options, IChannelManifestTransport transport, bool disposeTransport = false)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(transport);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.Url);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.Channel);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.StateRoot);
        ArgumentNullException.ThrowIfNull(options.SignatureVerifier);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.SignatureVerifier.VerifierIdentity);
        if (!Uri.TryCreate(options.Url, UriKind.Absolute, out var parsedUrl) || parsedUrl.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(parsedUrl.UserInfo) || !string.IsNullOrEmpty(parsedUrl.Fragment))
            throw new ArgumentException("Url must be absolute HTTPS without credentials or a fragment.", nameof(options));
        if (!Path.IsPathFullyQualified(options.StateRoot)) throw new ArgumentException("StateRoot must be absolute.", nameof(options));
        if (options.Timeout <= TimeSpan.Zero && options.Timeout != Timeout.InfiniteTimeSpan) throw new ArgumentOutOfRangeException(nameof(options));
        if (options.StateLockTimeout <= TimeSpan.Zero && options.StateLockTimeout != Timeout.InfiniteTimeSpan) throw new ArgumentOutOfRangeException(nameof(options));
        if (options.StateLockRetryDelay <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(options));
        if (options.MaxResponseBytes <= 0) throw new ArgumentOutOfRangeException(nameof(options));

        stateRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(options.StateRoot));
        cachePath = Path.Combine(stateRoot, CacheFileName);
        highWaterPath = Path.Combine(stateRoot, HighWaterFileName);
        stateLockPath = Path.Combine(stateRoot, LockFileName);
        ValidateNoReparsePoints(stateRoot, true);
        Directory.CreateDirectory(stateRoot);
        ValidateNoReparsePoints(stateRoot, true);
        rootIdentity = GetIdentity(stateRoot, true, false);

        url = parsedUrl;
        channel = options.Channel;
        verifier = options.SignatureVerifier;
        trustedSources = options.TrustedSources ?? OfflineUpdateDecision.DefaultTrustedReleaseSources;
        timeout = options.Timeout;
        stateLockTimeout = options.StateLockTimeout;
        stateLockRetryDelay = options.StateLockRetryDelay;
        maxResponseBytes = options.MaxResponseBytes;
        now = options.Now ?? (static () => DateTimeOffset.UtcNow);
        uniqueId = options.UniqueId ?? (static () => Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture));
        this.transport = transport;
        ownsTransport = disposeTransport;
        configIdentity = ComputeConfigIdentity(channel, url.AbsoluteUri, trustedSources, verifier.VerifierIdentity);
        mutexName = "MagicPot.ChannelManifest." + Convert.ToHexString(SHA256.HashData(StrictUtf8.GetBytes(stateRoot + "\n" + configIdentity)));
        ValidateState();
    }

    public async Task<ChannelManifestLoadResult> LoadAsync(CancellationToken cancellationToken = default)
    {
        using var namedLock = await AcquireNamedMutexAsync(cancellationToken).ConfigureAwait(false);
        await using var stateLock = await AcquireStateLockAsync(cancellationToken).ConfigureAwait(false);
        ValidateState(stateLock);
        var highWater = LoadHighWater();
        var cache = LoadVerifiedCache(highWater);
        if (cache is not null && highWater is null)
        {
            highWater = MakeHighWater(cache.Verified);
            AtomicWrite(highWaterPath, SerializeHighWater(highWater));
        }
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (cache?.ETag is not null && EntityTagHeaderValue.TryParse(cache.ETag, out var etag)) request.Headers.IfNoneMatch.Add(etag);
        if (cache?.LastModified is not null && DateTimeOffset.TryParse(cache.LastModified, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var modified)) request.Headers.IfModifiedSince = modified;
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (timeout != Timeout.InfiniteTimeSpan) timeoutSource.CancelAfter(timeout);
        HttpResponseMessage response;
        try { response = await transport.SendAsync(request, timeoutSource.Token).ConfigureAwait(false); }
        catch (Exception exception) when (IsSendTransportFailure(exception, cancellationToken))
        {
            if (cache is not null) return new ChannelManifestLoadResult(cache.Verified, "network-error-cache");
            throw new ChannelManifestClientException("Channel manifest transport failed and no acceptable cache exists.", ChannelManifestFailureKind.Unavailable, exception);
        }
        using (response)
        {
            ValidateFinalResponseUri(response);
            var status = (int)response.StatusCode;
            if (response.StatusCode == HttpStatusCode.NotModified)
            {
                if (cache is null) throw new ChannelManifestClientException("HTTP 304 requires an identity-bound, reverified cache.");
                return new ChannelManifestLoadResult(cache.Verified, "not-modified-cache");
            }
            if (status is >= 300 and <= 399) throw new ChannelManifestClientException("Channel manifest redirects are forbidden.");
            if (response.StatusCode != HttpStatusCode.OK) throw new ChannelManifestClientException("Unexpected channel manifest HTTP status " + status.ToString(CultureInfo.InvariantCulture) + ".");
            string raw;
            try { raw = await ReadBodyLimitedAsync(response, timeoutSource.Token, cancellationToken).ConfigureAwait(false); }
            catch (ChannelManifestTransportException exception)
            {
                if (cache is not null) return new ChannelManifestLoadResult(cache.Verified, "network-error-cache");
                throw new ChannelManifestClientException("Channel manifest body transport failed and no acceptable cache exists.", ChannelManifestFailureKind.Unavailable, exception);
            }
            VerifiedChannelManifestProof verified;
            try { verified = OfflineUpdateDecision.ParseAndVerifyChannelManifest(raw, channel, verifier, trustedSources); }
            catch (OfflineUpdateException exception) { throw new ChannelManifestClientException("Network channel manifest was rejected.", exception); }
            var nextHighWater = AcceptHighWater(verified, highWater);
            AtomicWrite(highWaterPath, SerializeHighWater(nextHighWater));
            var envelope = new CacheEnvelope(raw, response.Headers.ETag?.ToString(), response.Content.Headers.LastModified?.ToUniversalTime().ToString("R", CultureInfo.InvariantCulture), now().ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
            AtomicWrite(cachePath, SerializeCache(envelope));
            ValidateState(stateLock);
            return new ChannelManifestLoadResult(verified, "network");
        }
    }

    public void Dispose() { if (ownsTransport) transport.Dispose(); }

    private void ValidateFinalResponseUri(HttpResponseMessage response)
    {
        var finalUri = response.RequestMessage?.RequestUri;
        if (finalUri is null || Uri.Compare(url, finalUri, UriComponents.SchemeAndServer | UriComponents.PathAndQuery, UriFormat.UriEscaped, StringComparison.Ordinal) != 0)
            throw new ChannelManifestClientException("Channel manifest redirect/final URL mismatch.");
    }

    private async Task<WindowsNamedMutexLease> AcquireNamedMutexAsync(CancellationToken cancellationToken)
    {
        try { return await WindowsNamedMutexLease.AcquireAsync(mutexName, stateLockTimeout, stateLockRetryDelay, cancellationToken).ConfigureAwait(false); }
        catch (TimeoutException exception) { throw new ChannelManifestClientException("Timed out acquiring channel manifest named mutex.", exception); }
    }

    private async Task<FileStream> AcquireStateLockAsync(CancellationToken cancellationToken)
    {
        ValidateBoundRoot();
        var stopwatch = Stopwatch.StartNew();
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (OperatingSystem.IsWindows())
            {
                var handle = CreateFileW(stateLockPath, GenericRead | GenericWrite, FileShare.None, IntPtr.Zero, FileMode.OpenOrCreate,
                    FileFlagsAndAttributes.FileAttributeNormal | FileFlagsAndAttributes.FileFlagOpenReparsePoint | FileFlagsAndAttributes.FileFlagWriteThrough, IntPtr.Zero);
                if (handle.IsInvalid)
                {
                    var error = Marshal.GetLastWin32Error();
                    handle.Dispose();
                    var exception = new Win32Exception(error);
                    if (error is ErrorSharingViolation or ErrorLockViolation)
                    {
                        if (stateLockTimeout != Timeout.InfiniteTimeSpan && stopwatch.Elapsed >= stateLockTimeout)
                            throw new ChannelManifestClientException("Timed out acquiring channel manifest state lock.", exception);
                        await Task.Delay(NextDelay(stopwatch), cancellationToken).ConfigureAwait(false);
                        continue;
                    }
                    throw new ChannelManifestClientException("Channel manifest state lock could not be opened safely.", exception);
                }

                try
                {
                    ValidateOpenStateLock(handle);
                    var stream = new FileStream(handle, FileAccess.ReadWrite, 1, isAsync: false);
                    handle = null!; // FileStream owns the exact validated, exclusively opened handle.
                    try { ValidateState(stream); return stream; }
                    catch { stream.Dispose(); throw; }
                }
                finally { handle?.Dispose(); }
            }

            // The launcher is Windows-only; this fallback preserves library behavior on other runtimes.
            try
            {
                var stream = new FileStream(stateLockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.WriteThrough);
                try { ValidateState(stream); return stream; }
                catch { stream.Dispose(); throw; }
            }
            catch (IOException exception)
            {
                if (stateLockTimeout != Timeout.InfiniteTimeSpan && stopwatch.Elapsed >= stateLockTimeout)
                    throw new ChannelManifestClientException("Timed out acquiring channel manifest state lock.", exception);
                await Task.Delay(NextDelay(stopwatch), cancellationToken).ConfigureAwait(false);
            }
            catch (UnauthorizedAccessException exception)
            {
                throw new ChannelManifestClientException("Channel manifest state lock could not be opened safely.", exception);
            }
        }
    }

    private void ValidateOpenStateLock(SafeFileHandle handle)
    {
        if (!string.Equals(Path.GetDirectoryName(stateLockPath), stateRoot, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(Path.GetFileName(stateLockPath), LockFileName, StringComparison.Ordinal))
            throw new ChannelManifestClientException("State lock path is not the fixed direct child of StateRoot.");

        ValidateBoundRoot();
        _ = GetIdentity(handle, false, true);
        var openedPath = GetFinalPath(handle);
        if (!string.Equals(openedPath, stateLockPath, StringComparison.OrdinalIgnoreCase))
            throw new ChannelManifestClientException("State lock handle does not identify the fixed StateRoot child path.");
        ValidateBoundRoot();
    }

    private void ValidateBoundRoot()
    {
        ValidateNoReparsePoints(stateRoot, true);
        var currentRoot = GetIdentity(stateRoot, true, false);
        if (rootIdentity is not null && currentRoot != rootIdentity)
            throw new ChannelManifestClientException("StateRoot identity changed; refusing state access.");
    }

    private TimeSpan NextDelay(Stopwatch stopwatch)
    {
        var delay = stateLockRetryDelay;
        if (stateLockTimeout != Timeout.InfiniteTimeSpan)
        {
            var remaining = stateLockTimeout - stopwatch.Elapsed;
            if (remaining < delay) delay = remaining;
        }
        return delay > TimeSpan.Zero ? delay : TimeSpan.FromMilliseconds(1);
    }

    private CachedManifest? LoadVerifiedCache(HighWaterEnvelope? highWater)
    {
        ValidateState();
        if (!File.Exists(cachePath)) return null;
        ValidateStateFile(cachePath);
        string text;
        try { text = File.ReadAllText(cachePath, StrictUtf8); }
        catch (DecoderFallbackException exception)
        {
            QuarantineCorruptCache(new CacheContentException("Channel manifest cache is not strict UTF-8.", exception));
            return null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        { throw new ChannelManifestClientException("Channel manifest cache could not be read.", exception); }

        try
        {
            var envelope = ParseCache(text);
            if (!string.Equals(envelope.ConfigIdentity, configIdentity, StringComparison.Ordinal)) return null;
            VerifiedChannelManifestProof verified;
            try { verified = OfflineUpdateDecision.ParseAndVerifyChannelManifest(envelope.RawManifest, channel, verifier, trustedSources); }
            catch (OfflineUpdateException exception) { throw new CacheContentException("Cached channel manifest verification failed.", exception); }
            if (highWater is not null)
            {
                DateTimeOffset generated;
                DateTimeOffset old;
                try
                {
                    generated = DateTimeOffset.Parse(verified.Manifest.GeneratedAt, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
                    old = DateTimeOffset.Parse(highWater.GeneratedAt, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
                }
                catch (FormatException exception) { throw new CacheContentException("Cache/high-water timestamps are inconsistent.", exception); }
                if (generated < old || (generated == old && !string.Equals(verified.RawManifestSha256, highWater.Digest, StringComparison.Ordinal)))
                    throw new CacheContentException("Cached channel manifest is stale relative to high-water state.");
            }
            ValidateState();
            return new CachedManifest(verified, envelope.ETag, envelope.LastModified);
        }
        catch (JsonException exception)
        {
            QuarantineCorruptCache(new CacheContentException("Channel manifest cache JSON is invalid.", exception));
            return null;
        }
        catch (CacheContentException exception)
        {
            QuarantineCorruptCache(exception);
            return null;
        }
    }

    private void QuarantineCorruptCache(CacheContentException reason)
    {
        ValidateState();
        ValidateStateFile(cachePath);
        var quarantinePath = Path.Combine(stateRoot, "cache.corrupt-" + uniqueId() + ".json");
        if (!string.Equals(Path.GetDirectoryName(quarantinePath), stateRoot, StringComparison.OrdinalIgnoreCase) || File.Exists(quarantinePath) || Directory.Exists(quarantinePath))
            throw new ChannelManifestClientException("Corrupt cache quarantine path is unsafe or already exists.", reason);
        try { File.Move(cachePath, quarantinePath); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        { throw new ChannelManifestClientException("Corrupt cache could not be quarantined; refusing to overwrite it.", exception); }
        ValidateState();
        try
        {
            ValidateNoReparsePoints(quarantinePath, true);
            _ = GetIdentity(quarantinePath, false, true);
        }
        catch (ChannelManifestClientException exception) { throw new ChannelManifestClientException("Quarantined cache failed identity validation.", exception); }
    }

    private HighWaterEnvelope? LoadHighWater()
    {
        ValidateState();
        if (!File.Exists(highWaterPath)) return null;
        try
        {
            ValidateStateFile(highWaterPath);
            var value = ParseHighWater(File.ReadAllText(highWaterPath, StrictUtf8));
            if (!string.Equals(value.ConfigIdentity, configIdentity, StringComparison.Ordinal)) throw new ChannelManifestClientException("High-water config identity does not match.");
            ValidateState();
            return value;
        }
        catch (ChannelManifestClientException) { throw; }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException or DecoderFallbackException or FormatException or OfflineUpdateException)
        { throw new ChannelManifestClientException("High-water state is invalid; refusing network and cache use.", exception); }
    }

    private HighWaterEnvelope AcceptHighWater(VerifiedChannelManifestProof verified, HighWaterEnvelope? current)
    {
        var next = MakeHighWater(verified);
        if (current is null) return next;
        var nextTime = DateTimeOffset.Parse(next.GeneratedAt, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
        var oldTime = DateTimeOffset.Parse(current.GeneratedAt, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
        if (nextTime < oldTime) throw new ChannelManifestClientException("Channel manifest rollback rejected.");
        if (nextTime == oldTime && !string.Equals(next.Digest, current.Digest, StringComparison.Ordinal)) throw new ChannelManifestClientException("Channel manifest equivocation rejected.");
        return string.Equals(next.Digest, current.Digest, StringComparison.Ordinal) ? current : next;
    }

    private HighWaterEnvelope MakeHighWater(VerifiedChannelManifestProof verified)
    {
        var selected = verified.SelectLatestArtifacts();
        return new HighWaterEnvelope(verified.Manifest.GeneratedAt, verified.RawManifestSha256, selected is null ? "none" : OfflineUpdateDecision.ReleaseIdentity(selected.Release));
    }

    private async Task<string> ReadBodyLimitedAsync(HttpResponseMessage response, CancellationToken timeoutToken, CancellationToken callerToken)
    {
        var length = response.Content.Headers.ContentLength;
        if (length is > 0 && length > maxResponseBytes) throw new ChannelManifestClientException("Channel manifest Content-Length exceeds the configured limit.");
        try
        {
            await using var stream = await response.Content.ReadAsStreamAsync(timeoutToken).ConfigureAwait(false);
            using var buffer = new MemoryStream(length is > 0 and <= int.MaxValue ? (int)length.Value : 0);
            var chunk = new byte[81920];
            while (true)
            {
                var count = await stream.ReadAsync(chunk.AsMemory(0, chunk.Length), timeoutToken).ConfigureAwait(false);
                if (count == 0) break;
                if (buffer.Length + count > maxResponseBytes) throw new ChannelManifestClientException("Channel manifest stream exceeds the configured limit.");
                buffer.Write(chunk, 0, count);
            }
            try { return StrictUtf8.GetString(buffer.GetBuffer(), 0, checked((int)buffer.Length)); }
            catch (DecoderFallbackException exception) { throw new ChannelManifestClientException("Channel manifest is not strict UTF-8.", exception); }
        }
        catch (Exception exception) when (exception is IOException or HttpRequestException)
        { throw new ChannelManifestTransportException("Channel manifest response body transport failed.", exception); }
        catch (OperationCanceledException exception) when (!callerToken.IsCancellationRequested)
        { throw new ChannelManifestTransportException("Channel manifest response body timed out.", exception); }
    }

    private void AtomicWrite(string path, string text)
    {
        ValidateState();
        if (File.Exists(path)) ValidateStateFile(path);
        var temporary = Path.Combine(stateRoot, "." + Path.GetFileName(path) + "." + uniqueId() + ".tmp");
        if (!string.Equals(Path.GetDirectoryName(temporary), stateRoot, StringComparison.OrdinalIgnoreCase)) throw new ChannelManifestClientException("Temporary state path escaped StateRoot.");
        try
        {
            var bytes = StrictUtf8.GetBytes(text);
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
            ValidateState();
            ValidateStateFile(temporary);
            if (File.Exists(path)) File.Replace(temporary, path, null, true);
            else File.Move(temporary, path);
            ValidateState();
            ValidateStateFile(path);
        }
        catch (ChannelManifestClientException) { throw; }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        { throw new ChannelManifestClientException("Channel manifest state could not be written atomically.", exception); }
        finally { try { File.Delete(temporary); } catch (Exception) { } }
    }

    private void ValidateState(FileStream? openLock = null)
    {
        ValidateNoReparsePoints(stateRoot, true);
        var currentRoot = GetIdentity(stateRoot, true, false);
        if (rootIdentity is not null && currentRoot != rootIdentity) throw new ChannelManifestClientException("StateRoot identity changed; refusing state access.");
        var identities = new List<FileIdentity>();
        foreach (var path in new[] { cachePath, highWaterPath, stateLockPath })
        {
            if (!File.Exists(path)) continue;
            var identity = openLock is not null && string.Equals(path, stateLockPath, StringComparison.OrdinalIgnoreCase)
                ? GetIdentity(openLock.SafeFileHandle, false, true)
                : GetIdentity(path, false, true);
            if (identity is not null)
            {
                if (identities.Contains(identity.Value)) throw new ChannelManifestClientException("Fixed state files alias the same file identity.");
                identities.Add(identity.Value);
            }
        }
    }

    private void ValidateStateFile(string path)
    {
        ValidateState();
        _ = GetIdentity(path, false, true);
    }

    private static void ValidateNoReparsePoints(string path, bool requireLeaf)
    {
        var full = Path.GetFullPath(path);
        var root = Path.GetPathRoot(full) ?? throw new ChannelManifestClientException("State path has no root.");
        var current = root;
        foreach (var part in full[root.Length..].Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
        {
            if (part.Length == 0) continue;
            current = Path.Combine(current, part);
            if (!File.Exists(current) && !Directory.Exists(current))
            {
                if (requireLeaf && string.Equals(current, full, StringComparison.OrdinalIgnoreCase)) return;
                continue;
            }
            FileAttributes attributes;
            try { attributes = File.GetAttributes(current); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { throw new ChannelManifestClientException("State path could not be validated.", exception); }
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new ChannelManifestClientException("State paths must not traverse reparse points or junctions.");
        }
    }

    private static FileIdentity? GetIdentity(string path, bool directory, bool rejectMultipleLinks)
    {
        if (!OperatingSystem.IsWindows())
        {
            var attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0 || directory != ((attributes & FileAttributes.Directory) != 0))
                throw new ChannelManifestClientException("State object type or reparse status is invalid.");
            return null;
        }
        using var handle = CreateFileW(path, 0, FileShare.ReadWrite | FileShare.Delete, IntPtr.Zero, FileMode.Open,
            FileFlagsAndAttributes.FileFlagOpenReparsePoint | (directory ? FileFlagsAndAttributes.FileFlagBackupSemantics : 0), IntPtr.Zero);
        if (handle.IsInvalid) throw new ChannelManifestClientException("State object handle could not be opened.", new Win32Exception(Marshal.GetLastWin32Error()));
        return GetIdentity(handle, directory, rejectMultipleLinks);
    }

    private static FileIdentity? GetIdentity(SafeFileHandle handle, bool directory, bool rejectMultipleLinks)
    {
        if (!OperatingSystem.IsWindows()) return null;
        if (!GetFileInformationByHandle(handle, out var info)) throw new ChannelManifestClientException("State object identity could not be read.", new Win32Exception(Marshal.GetLastWin32Error()));
        var attributes = (FileAttributes)info.FileAttributes;
        if ((attributes & FileAttributes.ReparsePoint) != 0) throw new ChannelManifestClientException("State object must not be a reparse point.");
        if (directory != ((attributes & FileAttributes.Directory) != 0)) throw new ChannelManifestClientException("State object has an invalid type.");
        if (!directory && rejectMultipleLinks && info.NumberOfLinks > 1) throw new ChannelManifestClientException("State files must not have multiple hard links.");
        return new FileIdentity(info.VolumeSerialNumber, ((ulong)info.FileIndexHigh << 32) | info.FileIndexLow);
    }

    private static string GetFinalPath(SafeFileHandle handle)
    {
        var capacity = 512;
        while (true)
        {
            var buffer = new StringBuilder(capacity);
            var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, FinalPathNameNormalized | FinalPathNameDos);
            if (length == 0) throw new ChannelManifestClientException("State lock final path could not be read.", new Win32Exception(Marshal.GetLastWin32Error()));
            if (length < buffer.Capacity) return NormalizeFinalPath(buffer.ToString());
            capacity = checked((int)length + 1);
        }
    }

    private static string NormalizeFinalPath(string path)
    {
        const string uncPrefix = @"\\?\UNC\";
        const string extendedPrefix = @"\\?\";
        if (path.StartsWith(uncPrefix, StringComparison.OrdinalIgnoreCase)) return @"\\" + path[uncPrefix.Length..];
        return path.StartsWith(extendedPrefix, StringComparison.OrdinalIgnoreCase) ? path[extendedPrefix.Length..] : path;
    }

    private string SerializeCache(CacheEnvelope value) => JsonSerializer.Serialize(new Dictionary<string, object?>
    { ["schema"] = 1, ["rawManifest"] = value.RawManifest, ["etag"] = value.ETag, ["lastModified"] = value.LastModified, ["verifiedAt"] = value.VerifiedAt, ["configIdentity"] = configIdentity });
    private string SerializeHighWater(HighWaterEnvelope value) => JsonSerializer.Serialize(new Dictionary<string, object?>
    { ["schema"] = 1, ["configIdentity"] = configIdentity, ["generatedAt"] = value.GeneratedAt, ["digest"] = value.Digest, ["releaseIdentity"] = value.ReleaseIdentity });

    private static CacheEnvelope ParseCache(string text)
    {
        try
        {
            using var document = JsonDocument.Parse(text); var root = document.RootElement;
            RequireKeys(root, ["schema", "rawManifest", "verifiedAt", "configIdentity"], ["etag", "lastModified"]); RequireSchema(root);
            return new CacheEnvelope(String(root, "rawManifest"), OptionalString(root, "etag"), OptionalString(root, "lastModified"), Timestamp(root, "verifiedAt"), String(root, "configIdentity"));
        }
        catch (ChannelManifestClientException exception) { throw new CacheContentException("Channel manifest cache envelope is invalid.", exception); }
        catch (FormatException exception) { throw new CacheContentException("Channel manifest cache envelope contains an invalid value.", exception); }
    }

    private static HighWaterEnvelope ParseHighWater(string text)
    {
        using var document = JsonDocument.Parse(text); var root = document.RootElement;
        RequireKeys(root, ["schema", "configIdentity", "generatedAt", "digest", "releaseIdentity"], []); RequireSchema(root);
        var generatedAt = String(root, "generatedAt"); var digest = String(root, "digest"); var releaseIdentity = String(root, "releaseIdentity");
        OfflineUpdateDecision.ParseManifestHighWater(JsonSerializer.Serialize(new Dictionary<string, object?>
        { ["schema"] = 1, ["generatedAt"] = generatedAt, ["digest"] = digest, ["releaseIdentity"] = releaseIdentity }));
        return new HighWaterEnvelope(generatedAt, digest, releaseIdentity, String(root, "configIdentity"));
    }

    private static void RequireSchema(JsonElement root)
    {
        if (root.GetProperty("schema").ValueKind != JsonValueKind.Number || !root.GetProperty("schema").TryGetInt32(out var schema) || schema != 1) throw new ChannelManifestClientException("Persistence schema is invalid.");
    }
    private static void RequireKeys(JsonElement root, IReadOnlyCollection<string> required, IReadOnlyCollection<string> optional)
    {
        if (root.ValueKind != JsonValueKind.Object) throw new ChannelManifestClientException("Persistence envelope must be an object.");
        var names = root.EnumerateObject().Select(static p => p.Name).ToArray();
        if (names.Distinct(StringComparer.Ordinal).Count() != names.Length) throw new ChannelManifestClientException("Persistence envelope has duplicate fields.");
        foreach (var name in required) if (!names.Contains(name, StringComparer.Ordinal)) throw new ChannelManifestClientException("Persistence envelope is missing " + name + ".");
        foreach (var name in names) if (!required.Contains(name) && !optional.Contains(name)) throw new ChannelManifestClientException("Persistence envelope has unknown field " + name + ".");
    }
    private static string String(JsonElement root, string name) { var value = root.GetProperty(name); if (value.ValueKind != JsonValueKind.String) throw new ChannelManifestClientException(name + " must be a string."); return value.GetString()!; }
    private static string? OptionalString(JsonElement root, string name) { if (!root.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null) return null; if (value.ValueKind != JsonValueKind.String) throw new ChannelManifestClientException(name + " must be a string or null."); return value.GetString(); }
    private static string Timestamp(JsonElement root, string name) { var value = String(root, name); if (!DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out _)) throw new ChannelManifestClientException(name + " is not a timestamp."); return value; }

    private static string ComputeConfigIdentity(string channel, string absoluteUrl, IReadOnlyList<TrustedReleaseSource> sources, string verifierIdentity)
    {
        var normalized = sources.Select(static s => new Dictionary<string, object?> { ["origin"] = s.Origin, ["prefix"] = s.RepoPathPrefix })
            .OrderBy(static s => (string)s["origin"]!, StringComparer.Ordinal).ThenBy(static s => (string)s["prefix"]!, StringComparer.Ordinal).ToArray();
        var canonical = OfflineUpdateDecision.CanonicalJson(new Dictionary<string, object?> { ["channel"] = channel, ["verifierIdentity"] = verifierIdentity, ["trustedSources"] = normalized, ["url"] = absoluteUrl });
        return Convert.ToHexString(SHA256.HashData(StrictUtf8.GetBytes(canonical))).ToLowerInvariant();
    }
    private static bool IsSendTransportFailure(Exception exception, CancellationToken callerToken) => exception is HttpRequestException || (exception is OperationCanceledException && !callerToken.IsCancellationRequested);

    private sealed class CacheContentException : Exception
    {
        public CacheContentException(string message) : base(message) { }
        public CacheContentException(string message, Exception innerException) : base(message, innerException) { }
    }

    private readonly record struct FileIdentity(uint VolumeSerialNumber, ulong FileIndex);
    private sealed record CacheEnvelope(string RawManifest, string? ETag, string? LastModified, string VerifiedAt, string ConfigIdentity = "");
    private sealed record CachedManifest(VerifiedChannelManifestProof Verified, string? ETag, string? LastModified);
    private sealed record HighWaterEnvelope(string GeneratedAt, string Digest, string ReleaseIdentity, string ConfigIdentity = "");

    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const int ErrorSharingViolation = 32;
    private const int ErrorLockViolation = 33;
    private const uint FinalPathNameNormalized = 0;
    private const uint FinalPathNameDos = 0;

    [Flags]
    private enum FileFlagsAndAttributes : uint
    {
        FileAttributeNormal = 0x00000080,
        FileFlagWriteThrough = 0x80000000,
        FileFlagBackupSemantics = 0x02000000,
        FileFlagOpenReparsePoint = 0x00200000
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern SafeFileHandle CreateFileW(string fileName, uint desiredAccess, FileShare shareMode, IntPtr securityAttributes, FileMode creationDisposition, FileFlagsAndAttributes flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out ByHandleFileInformation fileInformation);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder filePath, uint filePathLength, uint flags);
}
