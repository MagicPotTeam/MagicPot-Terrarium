using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

namespace MagicPot.Launcher;

public sealed class OfflineUpdateException(string message) : Exception(message);
public sealed record LauncherSettingsV1(int Schema, string UpdateMode, string Channel, int RetainAppVersions, int RetainNightlyVersions, bool AllowPrerelease);
public sealed record ManifestSignatureV1(string Algorithm, string KeyId, string Value);
public sealed record TrustedReleaseSource(string Origin, string RepoPathPrefix);
public abstract record ArtifactV1(string Kind, string Platform, string Arch, string Url, string Sha256, long Size, long UnpackedSize, string CreatedAt);
public sealed record AppArtifactV1(string Kind, string Version, string BuildId, string CommitSha, string RuntimeId, string Platform, string Arch, string Url, string Sha256, long Size, long UnpackedSize, string Entrypoint, string CreatedAt) : ArtifactV1(Kind, Platform, Arch, Url, Sha256, Size, UnpackedSize, CreatedAt);
public sealed record RuntimeArtifactV1(string Kind, string RuntimeId, string Platform, string Arch, string Url, string Sha256, long Size, long UnpackedSize, string Entrypoint, string CreatedAt) : ArtifactV1(Kind, Platform, Arch, Url, Sha256, Size, UnpackedSize, CreatedAt);
public sealed record ReleaseArtifactsV1(AppArtifactV1 App, RuntimeArtifactV1? Runtime);
public sealed record ChannelReleaseV1(string Version, string BuildId, string CommitSha, string PublishedAt, string ReleaseNotesUrl, string MinimumLauncherVersion, ReleaseArtifactsV1 Artifacts);
public sealed record ChannelManifestV1(int Schema, string Channel, string GeneratedAt, IReadOnlyList<ChannelReleaseV1> Releases, ManifestSignatureV1 Signature);
internal sealed class VerifiedChannelManifestProof
{
    private VerifiedChannelManifestProof(ChannelManifestV1 manifest, string rawManifestSha256, string signingPayloadSha256, string signatureKeyId, string verifierIdentity)
    {
        Manifest = Freeze(manifest);
        RawManifestSha256 = rawManifestSha256;
        SigningPayloadSha256 = signingPayloadSha256;
        SignatureKeyId = signatureKeyId;
        VerifierIdentity = verifierIdentity;
        Channel = Manifest.Channel;
        GeneratedAt = Manifest.GeneratedAt;
    }

    public ChannelManifestV1 Manifest { get; }
    public string RawManifestSha256 { get; }
    public string RawSha256 => RawManifestSha256;
    public string SigningPayloadSha256 { get; }
    public string SignatureKeyId { get; }
    public string VerifierIdentity { get; }
    public string KeySetIdentity => VerifierIdentity;
    public string Channel { get; }
    public string GeneratedAt { get; }

    public SelectedArtifactsV1? SelectLatestArtifacts(string platform = "win32", string arch = "x64", Func<ChannelReleaseV1, bool>? predicate = null) =>
        OfflineUpdateDecision.SelectLatestArtifacts(Manifest, platform, arch, predicate);

    public VerifiedArtifactRequest CreateAppRequest(SelectedArtifactsV1 selection) => CreateArtifactRequest(selection, false);
    public VerifiedArtifactRequest CreateRuntimeRequest(SelectedArtifactsV1 selection) => CreateArtifactRequest(selection, true);
    public (VerifiedArtifactRequest App, VerifiedArtifactRequest Runtime) CreateRequests(SelectedArtifactsV1 selection) =>
        (CreateAppRequest(selection), CreateRuntimeRequest(selection));

    internal static VerifiedChannelManifestProof Create(ChannelManifestV1 manifest, string rawManifestSha256, string signingPayloadSha256, string signatureKeyId, string verifierIdentity) =>
        new(manifest, rawManifestSha256, signingPayloadSha256, signatureKeyId, verifierIdentity);

    private VerifiedArtifactRequest CreateArtifactRequest(SelectedArtifactsV1 selection, bool runtime)
    {
        ArgumentNullException.ThrowIfNull(selection);
        var release = Manifest.Releases.FirstOrDefault(candidate => ReferenceEquals(candidate, selection.Release))
            ?? throw new OfflineUpdateException("selection.release: release was not selected from this verified manifest");
        if (!ReferenceEquals(release.Artifacts.App, selection.App))
            throw new OfflineUpdateException("selection.app: artifact was not selected from this verified manifest");
        var runtimeArtifact = Manifest.Releases.Select(candidate => candidate.Artifacts.Runtime)
            .FirstOrDefault(candidate => ReferenceEquals(candidate, selection.Runtime))
            ?? throw new OfflineUpdateException("selection.runtime: artifact was not selected from this verified manifest");
        if (selection.App.RuntimeId != runtimeArtifact.RuntimeId)
            throw new OfflineUpdateException("selection.runtime: runtime does not satisfy the selected app");
        return VerifiedArtifactRequest.Create(runtime ? runtimeArtifact : selection.App, this);
    }

    private static ChannelManifestV1 Freeze(ChannelManifestV1 manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        var releases = new List<ChannelReleaseV1>(manifest.Releases.Count);
        foreach (var release in manifest.Releases)
        {
            var app = release.Artifacts.App;
            var frozenApp = new AppArtifactV1(app.Kind, app.Version, app.BuildId, app.CommitSha, app.RuntimeId, app.Platform, app.Arch, app.Url, app.Sha256, app.Size, app.UnpackedSize, app.Entrypoint, app.CreatedAt);
            var runtime = release.Artifacts.Runtime;
            var frozenRuntime = runtime is null ? null : new RuntimeArtifactV1(runtime.Kind, runtime.RuntimeId, runtime.Platform, runtime.Arch, runtime.Url, runtime.Sha256, runtime.Size, runtime.UnpackedSize, runtime.Entrypoint, runtime.CreatedAt);
            releases.Add(new ChannelReleaseV1(release.Version, release.BuildId, release.CommitSha, release.PublishedAt, release.ReleaseNotesUrl, release.MinimumLauncherVersion, new ReleaseArtifactsV1(frozenApp, frozenRuntime)));
        }
        var signature = new ManifestSignatureV1(manifest.Signature.Algorithm, manifest.Signature.KeyId, manifest.Signature.Value);
        return new ChannelManifestV1(manifest.Schema, manifest.Channel, manifest.GeneratedAt, new ReadOnlyCollection<ChannelReleaseV1>(releases), signature);
    }
}

internal sealed class VerifiedArtifactRequest
{
    private VerifiedArtifactRequest(ArtifactV1 artifact, VerifiedChannelManifestProof proof)
    {
        Artifact = artifact;
        Proof = proof;
    }

    internal static VerifiedArtifactRequest Create(ArtifactV1 artifact, VerifiedChannelManifestProof proof) => new(artifact, proof);
    internal ArtifactV1 Artifact { get; }
    internal VerifiedChannelManifestProof Proof { get; }
}
public sealed record SelectedArtifactsV1(ChannelReleaseV1 Release, AppArtifactV1 App, RuntimeArtifactV1 Runtime);
public sealed record ManifestHighWaterV1(int Schema, string GeneratedAt, string Digest, string ReleaseIdentity);

internal interface IChannelManifestSignatureVerifier { string VerifierIdentity { get; } bool Verify(ReadOnlySpan<byte> payload, ManifestSignatureV1 signature, out string error); }

internal sealed class Ed25519ChannelManifestSignatureVerifier : IChannelManifestSignatureVerifier
{
    private readonly IReadOnlyDictionary<string, byte[]> publicKeys;

    public Ed25519ChannelManifestSignatureVerifier(IReadOnlyDictionary<string, byte[]> publicKeys)
    {
        ArgumentNullException.ThrowIfNull(publicKeys);
        var copies = new Dictionary<string, byte[]>(publicKeys.Count, StringComparer.Ordinal);
        foreach (var entry in publicKeys)
        {
            if (entry.Key is null) throw new ArgumentException("Public key identifiers cannot be null.", nameof(publicKeys));
            if (entry.Value is null) throw new ArgumentException("Public key values cannot be null.", nameof(publicKeys));
            copies.Add(entry.Key, (byte[])entry.Value.Clone());
        }
        this.publicKeys = copies;
        using var identity = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var entry in copies.OrderBy(static item => item.Key, StringComparer.Ordinal))
        {
            var keyId = Encoding.UTF8.GetBytes(entry.Key);
            identity.AppendData(BitConverter.GetBytes(keyId.Length));
            identity.AppendData(keyId);
            identity.AppendData(entry.Value);
        }
        VerifierIdentity = "ed25519-keyset-sha256:" + Convert.ToHexString(identity.GetHashAndReset()).ToLowerInvariant();
    }

    public string VerifierIdentity { get; }

    public Ed25519ChannelManifestSignatureVerifier(IReadOnlyDictionary<string, string> base64PublicKeys)
        : this(DecodePublicKeys(base64PublicKeys))
    {
    }

    public bool Verify(ReadOnlySpan<byte> payload, ManifestSignatureV1 signature, out string error)
    {
        try
        {
            if (signature is null) return Fail("Signature metadata is missing.", out error);
            if (!string.Equals(signature.Algorithm, "ed25519", StringComparison.Ordinal))
                return Fail("Unsupported signature algorithm; expected ed25519.", out error);
            if (!publicKeys.TryGetValue(signature.KeyId, out var publicKey))
                return Fail("The signature key identifier is not configured.", out error);
            if (publicKey.Length != Ed25519PublicKeyParameters.KeySize)
                return Fail("The configured Ed25519 public key must be 32 bytes.", out error);
            if (!TryDecodeBase64(signature.Value, out var signatureBytes))
                return Fail("The signature value is not valid canonical base64.", out error);
            if (signatureBytes.Length != 64)
                return Fail("The Ed25519 signature must be 64 bytes.", out error);

            var verifier = new Ed25519Signer();
            verifier.Init(false, new Ed25519PublicKeyParameters(publicKey, 0));
            var payloadBytes = payload.ToArray();
            verifier.BlockUpdate(payloadBytes, 0, payloadBytes.Length);
            if (!verifier.VerifySignature(signatureBytes))
                return Fail("Ed25519 signature verification failed.", out error);

            error = string.Empty;
            return true;
        }
        catch (Exception exception)
        {
            error = "Ed25519 signature verification could not be completed (" + exception.GetType().Name + ").";
            return false;
        }
    }

    private static IReadOnlyDictionary<string, byte[]> DecodePublicKeys(IReadOnlyDictionary<string, string> publicKeys)
    {
        ArgumentNullException.ThrowIfNull(publicKeys);
        var decoded = new Dictionary<string, byte[]>(publicKeys.Count, StringComparer.Ordinal);
        foreach (var entry in publicKeys)
        {
            if (entry.Key is null) throw new ArgumentException("Public key identifiers cannot be null.", nameof(publicKeys));
            if (!TryDecodeBase64(entry.Value, out var bytes))
                throw new ArgumentException("A configured Ed25519 public key is not valid canonical base64.", nameof(publicKeys));
            decoded.Add(entry.Key, bytes);
        }
        return decoded;
    }

    private static bool TryDecodeBase64(string? value, out byte[] bytes)
    {
        bytes = [];
        if (value is null) return false;
        try
        {
            bytes = Convert.FromBase64String(value);
            return string.Equals(Convert.ToBase64String(bytes), value, StringComparison.Ordinal);
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static bool Fail(string message, out string error)
    {
        error = message;
        return false;
    }
}

internal sealed class ProductionFailClosedSignatureVerifier : IChannelManifestSignatureVerifier
{
    public string VerifierIdentity => "fail-closed:v1";
    public bool Verify(ReadOnlySpan<byte> payload, ManifestSignatureV1 signature, out string error)
    {
        error = "No trusted channel-manifest signature verifier was configured; production verification fails closed.";
        return false;
    }
}

public static partial class OfflineUpdateDecision
{
    public const long MaxArtifactSize = 1_099_511_627_776;
    public static readonly IReadOnlyList<TrustedReleaseSource> DefaultTrustedReleaseSources =
        [new("https://github.com", "/MagicPotTeam/MagicPot-Terrarium-Releases")];
    private const long MaxSafeInteger = 9_007_199_254_740_991;

    public static LauncherSettingsV1 ParseLauncherSettings(string text) => Parse(text, root =>
    {
        Keys(root, ["schema", "updateMode", "channel", "retainAppVersions", "allowPrerelease"], ["retainNightlyVersions"]);
        var value = new LauncherSettingsV1(Int(root, "schema"), Str(root, "updateMode"), Str(root, "channel"), Int(root, "retainAppVersions"), root.TryGetProperty("retainNightlyVersions", out _) ? Int(root, "retainNightlyVersions") : 3, Bool(root, "allowPrerelease"));
        Need(value.Schema == 1, "schema: unsupported schema");
        Need(value.UpdateMode is "manual" or "notify-on-launch" or "auto-on-launch", "updateMode: unsupported value");
        Need(IsChannel(value.Channel), "channel: unsupported value");
        Need(value.RetainAppVersions is >= 1 and <= 100 && value.RetainNightlyVersions is >= 1 and <= 100, "retain: expected 1..100");
        return value;
    });

    public static ChannelManifestV1 ParseChannelManifest(string raw, string expectedChannel, IReadOnlyList<TrustedReleaseSource>? trustedSources = null) => Parse<ChannelManifestV1>(raw, root =>
    {
        var sources = NormalizeSources(trustedSources ?? DefaultTrustedReleaseSources);
        Keys(root, ["schema", "channel", "generatedAt", "releases", "signature"]);
        Need(Int(root, "schema") == 1, "schema: unsupported schema");
        var channel = Str(root, "channel");
        Need(IsChannel(channel) && channel == expectedChannel, "channel: does not match requested channel");
        var array = root.GetProperty("releases");
        Need(array.ValueKind == JsonValueKind.Array && array.GetArrayLength() <= 1000, "releases: expected array of at most 1000");
        var releases = new ReadOnlyCollection<ChannelReleaseV1>(array.EnumerateArray().Select((item, index) => Release(item, sources, $"releases[{index}]")).ToList());
        var builds = new HashSet<string>(StringComparer.Ordinal);
        var versions = new Dictionary<string, string>(StringComparer.Ordinal);
        var runtimes = new HashSet<string>(StringComparer.Ordinal);
        foreach (var release in releases)
        {
            Need(builds.Add(release.BuildId), $"releases: duplicate buildId {release.BuildId}");
            if (versions.TryGetValue(release.Version, out var build)) Need(build == release.BuildId, $"releases: version {release.Version} conflicts");
            else versions.Add(release.Version, release.BuildId);
            if (release.Artifacts.Runtime is not null) Need(runtimes.Add(release.Artifacts.Runtime.RuntimeId), $"releases: duplicate runtimeId {release.Artifacts.Runtime.RuntimeId}");
        }
        return new(1, channel, Time(root, "generatedAt", "$"), releases, Signature(root.GetProperty("signature")));
    });

    internal static VerifiedChannelManifestProof ParseAndVerifyChannelManifest(string raw, string expectedChannel, IChannelManifestSignatureVerifier? verifier = null, IReadOnlyList<TrustedReleaseSource>? trustedSources = null)
    {
        var manifest = ParseChannelManifest(raw, expectedChannel, trustedSources);
        verifier ??= new ProductionFailClosedSignatureVerifier();
        var signingPayload = SigningPayload(manifest);
        if (!verifier.Verify(signingPayload, manifest.Signature, out var error))
            throw new OfflineUpdateException("signature: verification failed: " + error);
        // High-water uses the exact received UTF-8 text digest. This local safety layer is not part of the manifest schema.
        return VerifiedChannelManifestProof.Create(manifest, Sha256(raw), Convert.ToHexString(SHA256.HashData(signingPayload)).ToLowerInvariant(), manifest.Signature.KeyId, verifier.VerifierIdentity);
    }

    public static byte[] SigningPayload(ChannelManifestV1 manifest) => Encoding.UTF8.GetBytes(CanonicalJson(UnsignedManifestObject(manifest)));

    public static string CanonicalJson(string json)
    {
        using var document = JsonDocument.Parse(json);
        return CanonicalJson(document.RootElement);
    }

    public static string CanonicalJson(JsonElement value)
    {
        var builder = new StringBuilder();
        Canon(value, builder);
        return builder.ToString();
    }

    public static string CanonicalJson(object? value)
    {
        var builder = new StringBuilder();
        CanonObject(value, builder);
        return builder.ToString();
    }

    public static SelectedArtifactsV1? SelectLatestArtifacts(ChannelManifestV1 manifest, string platform = "win32", string arch = "x64", Func<ChannelReleaseV1, bool>? predicate = null)
    {
        predicate ??= static _ => true;
        var runtimes = new Dictionary<string, RuntimeArtifactV1>(StringComparer.Ordinal);
        foreach (var release in manifest.Releases)
        {
            var runtime = release.Artifacts.Runtime;
            if (runtime is not null && runtime.Platform == platform && runtime.Arch == arch)
                runtimes[runtime.RuntimeId] = runtime;
        }

        var compatible = manifest.Releases
            .Where(item => TryParseSemanticVersion(item.Version, out _) && predicate(item) && item.Artifacts.App.Platform == platform && item.Artifacts.App.Arch == arch)
            .ToList();
        compatible.Sort((left, right) =>
        {
            var precedence = CompareSemanticVersions(right.Version, left.Version) ?? 0;
            if (precedence != 0) return precedence;
            var published = ParseTime(right.PublishedAt).CompareTo(ParseTime(left.PublishedAt));
            return published != 0 ? published : StringComparer.Ordinal.Compare(right.BuildId, left.BuildId);
        });
        foreach (var release in compatible)
        {
            var app = release.Artifacts.App;
            if (runtimes.TryGetValue(app.RuntimeId, out var runtime))
                return new(release, app, runtime);
        }
        return null;
    }

    public static SelectedArtifactsV1? SelectLatestArtifactsWithPolicy(ChannelManifestV1 manifest, LauncherSettingsV1 settings, string launcherVersion)
    {
        if (manifest.Channel != settings.Channel) return null;
        if (!TryParseSemanticVersion(launcherVersion, out _)) return null;
        return SelectLatestArtifacts(manifest, "win32", "x64", release =>
        {
            if (!TryParseSemanticVersion(release.Version, out var version)) return false;
            if (!settings.AllowPrerelease && version.Prerelease.Count != 0) return false;
            var compatibility = CompareSemanticVersions(launcherVersion, release.MinimumLauncherVersion);
            return compatibility is >= 0;
        });
    }

    public static ManifestHighWaterV1 ParseManifestHighWater(string text) => Parse(text, root =>
    {
        Keys(root, ["schema", "generatedAt", "digest", "releaseIdentity"]);
        var value = new ManifestHighWaterV1(Int(root, "schema"), Time(root, "generatedAt", "$"), Str(root, "digest"), Str(root, "releaseIdentity"));
        Need(value.Schema == 1 && ShaRegex().IsMatch(value.Digest) && Identity(value.ReleaseIdentity), "manifest high water does not match schema 1");
        return value;
    });

    internal static ManifestHighWaterV1 AcceptHighWater(VerifiedChannelManifestProof verified, ManifestHighWaterV1? current, SelectedArtifactsV1? selected)
    {
        if (current is not null)
        {
            var next = ParseTime(verified.Manifest.GeneratedAt);
            var old = ParseTime(current.GeneratedAt);
            if (next < old) throw new OfflineUpdateException("generatedAt: rollback rejected");
            if (next == old && verified.RawManifestSha256 != current.Digest) throw new OfflineUpdateException("digest: equivocation rejected");
            if (verified.RawManifestSha256 == current.Digest) return current;
        }
        return new(1, verified.Manifest.GeneratedAt, verified.RawManifestSha256, selected is null ? "none" : ReleaseIdentity(selected.Release));
    }

    public static string ReleaseIdentity(ChannelReleaseV1 release) => $"{release.Version}/{release.BuildId}/{release.CommitSha}";
    public static string Sha256(string raw) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw))).ToLowerInvariant();
    public static int? CompareSemanticVersions(string left, string right)
    {
        if (!TryParseSemanticVersion(left, out var a) || !TryParseSemanticVersion(right, out var b)) return null;
        for (var index = 0; index < 3; index++)
            if (a.Core[index] != b.Core[index]) return a.Core[index] > b.Core[index] ? 1 : -1;
        if (a.Prerelease.Count == 0 || b.Prerelease.Count == 0)
            return a.Prerelease.Count == b.Prerelease.Count ? 0 : a.Prerelease.Count == 0 ? 1 : -1;
        var length = Math.Max(a.Prerelease.Count, b.Prerelease.Count);
        for (var index = 0; index < length; index++)
        {
            var leftPart = index < a.Prerelease.Count ? a.Prerelease[index] : null;
            var rightPart = index < b.Prerelease.Count ? b.Prerelease[index] : null;
            if (leftPart is null || rightPart is null) return leftPart == rightPart ? 0 : leftPart is null ? -1 : 1;
            if (leftPart == rightPart) continue;
            var leftNumeric = DigitsRegex().IsMatch(leftPart);
            var rightNumeric = DigitsRegex().IsMatch(rightPart);
            if (leftNumeric && rightNumeric)
            {
                var order = CompareNumericIdentifiers(leftPart, rightPart);
                if (order != 0) return order;
                continue;
            }
            if (leftNumeric != rightNumeric) return leftNumeric ? -1 : 1;
            return StringComparer.Ordinal.Compare(leftPart, rightPart) > 0 ? 1 : -1;
        }
        return 0;
    }

    private static ChannelReleaseV1 Release(JsonElement root, IReadOnlyList<TrustedReleaseSource> sources, string path)
    {
        Keys(root, ["version", "buildId", "commitSha", "publishedAt", "releaseNotesUrl", "minimumLauncherVersion", "artifacts"], null, path);
        var artifacts = root.GetProperty("artifacts");
        Keys(artifacts, ["app"], ["runtime"], path + ".artifacts");
        var release = new ChannelReleaseV1(
            Ver(root, "version", path), Build(root, "buildId", path), Commit(root, "commitSha", path), Time(root, "publishedAt", path),
            TrustedReleaseUrl(root, "releaseNotesUrl", path, sources), Ver(root, "minimumLauncherVersion", path),
            new(App(artifacts.GetProperty("app"), sources, path + ".artifacts.app"), artifacts.TryGetProperty("runtime", out var runtime) ? Runtime(runtime, sources, path + ".artifacts.runtime") : null));
        Need(release.Artifacts.App.Version == release.Version && release.Artifacts.App.BuildId == release.BuildId && release.Artifacts.App.CommitSha == release.CommitSha, path + ": release/app identity mismatch");
        Need(release.BuildId.EndsWith(release.CommitSha[..7], StringComparison.Ordinal), path + ": buildId/commit mismatch");
        if (release.Artifacts.Runtime is not null) Need(release.Artifacts.Runtime.RuntimeId == release.Artifacts.App.RuntimeId, path + ": runtimeId mismatch");
        return release;
    }

    private static AppArtifactV1 App(JsonElement root, IReadOnlyList<TrustedReleaseSource> sources, string path)
    {
        Keys(root, ["kind", "version", "buildId", "commitSha", "runtimeId", "platform", "arch", "url", "sha256", "size", "unpackedSize", "entrypoint", "createdAt"], null, path);
        Need(Str(root, "kind") == "app", path + ".kind: expected app");
        var value = new AppArtifactV1("app", Ver(root, "version", path), Build(root, "buildId", path), Commit(root, "commitSha", path), Id(root, "runtimeId", path), Platform(root, path), Arch(root, path), TrustedReleaseUrl(root, "url", path, sources), Hash(root, path), Size(root, "size", path), Size(root, "unpackedSize", path), Entrypoint(root, "entrypoint", path), Time(root, "createdAt", path));
        Need(value.Entrypoint.EndsWith(".exe", StringComparison.OrdinalIgnoreCase), path + ".entrypoint: app entrypoint must be executable");
        Need(value.BuildId.EndsWith(value.CommitSha[..7], StringComparison.Ordinal), path + ": buildId/commit mismatch");
        return value;
    }

    private static RuntimeArtifactV1 Runtime(JsonElement root, IReadOnlyList<TrustedReleaseSource> sources, string path)
    {
        Keys(root, ["kind", "runtimeId", "platform", "arch", "url", "sha256", "size", "unpackedSize", "entrypoint", "createdAt"], null, path);
        Need(Str(root, "kind") == "runtime", path + ".kind: expected runtime");
        return new RuntimeArtifactV1("runtime", Id(root, "runtimeId", path), Platform(root, path), Arch(root, path), TrustedReleaseUrl(root, "url", path, sources), Hash(root, path), Size(root, "size", path), Size(root, "unpackedSize", path), Entrypoint(root, "entrypoint", path), Time(root, "createdAt", path));
    }

    private static ManifestSignatureV1 Signature(JsonElement root)
    {
        Keys(root, ["algorithm", "keyId", "value"], null, "signature");
        Need(Str(root, "algorithm") == "ed25519", "signature.algorithm: expected ed25519");
        var text = Str(root, "value");
        byte[] bytes;
        try { bytes = Convert.FromBase64String(text); }
        catch { throw new OfflineUpdateException("signature.value: invalid base64"); }
        Need(bytes.Length == 64 && Convert.ToBase64String(bytes) == text, "signature.value: expected canonical 64-byte base64");
        return new("ed25519", Id(root, "keyId", "signature"), text);
    }

    private static IReadOnlyDictionary<string, object?> UnsignedManifestObject(ChannelManifestV1 manifest) => new Dictionary<string, object?>
    {
        ["schema"] = manifest.Schema,
        ["channel"] = manifest.Channel,
        ["generatedAt"] = manifest.GeneratedAt,
        ["releases"] = manifest.Releases.Select(ReleaseObject).ToArray()
    };

    private static IReadOnlyDictionary<string, object?> ReleaseObject(ChannelReleaseV1 release) => new Dictionary<string, object?>
    {
        ["version"] = release.Version, ["buildId"] = release.BuildId, ["commitSha"] = release.CommitSha,
        ["publishedAt"] = release.PublishedAt, ["releaseNotesUrl"] = release.ReleaseNotesUrl,
        ["minimumLauncherVersion"] = release.MinimumLauncherVersion,
        ["artifacts"] = release.Artifacts.Runtime is null
            ? new Dictionary<string, object?> { ["app"] = AppObject(release.Artifacts.App) }
            : new Dictionary<string, object?> { ["app"] = AppObject(release.Artifacts.App), ["runtime"] = RuntimeObject(release.Artifacts.Runtime) }
    };

    private static IReadOnlyDictionary<string, object?> AppObject(AppArtifactV1 app) => new Dictionary<string, object?>
    {
        ["kind"] = app.Kind, ["version"] = app.Version, ["buildId"] = app.BuildId, ["commitSha"] = app.CommitSha,
        ["runtimeId"] = app.RuntimeId, ["platform"] = app.Platform, ["arch"] = app.Arch, ["url"] = app.Url,
        ["sha256"] = app.Sha256, ["size"] = app.Size, ["unpackedSize"] = app.UnpackedSize,
        ["entrypoint"] = app.Entrypoint, ["createdAt"] = app.CreatedAt
    };

    private static IReadOnlyDictionary<string, object?> RuntimeObject(RuntimeArtifactV1 runtime) => new Dictionary<string, object?>
    {
        ["kind"] = runtime.Kind, ["runtimeId"] = runtime.RuntimeId, ["platform"] = runtime.Platform, ["arch"] = runtime.Arch,
        ["url"] = runtime.Url, ["sha256"] = runtime.Sha256, ["size"] = runtime.Size,
        ["unpackedSize"] = runtime.UnpackedSize, ["entrypoint"] = runtime.Entrypoint, ["createdAt"] = runtime.CreatedAt
    };

    private static void CanonObject(object? value, StringBuilder builder)
    {
        switch (value)
        {
            case null: builder.Append("null"); return;
            case bool boolean: builder.Append(boolean ? "true" : "false"); return;
            case string text: JsonString(text, builder); return;
            case int number: builder.Append(number.ToString(CultureInfo.InvariantCulture)); return;
            case long number:
                Need(number is >= -MaxSafeInteger and <= MaxSafeInteger, "$: canonical JSON accepts safe integers only");
                builder.Append(number.ToString(CultureInfo.InvariantCulture)); return;
            case IReadOnlyDictionary<string, object?> dictionary:
                builder.Append('{'); var firstProperty = true;
                foreach (var item in dictionary.OrderBy(item => item.Key, StringComparer.Ordinal))
                { if (!firstProperty) builder.Append(','); firstProperty = false; JsonString(item.Key, builder); builder.Append(':'); CanonObject(item.Value, builder); }
                builder.Append('}'); return;
            case System.Collections.IEnumerable enumerable:
                builder.Append('['); var firstItem = true;
                foreach (var item in enumerable) { if (!firstItem) builder.Append(','); firstItem = false; CanonObject(item, builder); }
                builder.Append(']'); return;
            default: throw new OfflineUpdateException("$: value is not JSON-serializable");
        }
    }

    private static void Canon(JsonElement value, StringBuilder builder)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Null: builder.Append("null"); break;
            case JsonValueKind.True: builder.Append("true"); break;
            case JsonValueKind.False: builder.Append("false"); break;
            case JsonValueKind.String: JsonString(value.GetString()!, builder); break;
            case JsonValueKind.Number:
                Need(value.TryGetInt64(out var number) && number is >= -MaxSafeInteger and <= MaxSafeInteger, "$: canonical JSON accepts safe integers only");
                builder.Append(number.ToString(CultureInfo.InvariantCulture)); break;
            case JsonValueKind.Array:
                builder.Append('['); var firstItem = true;
                foreach (var item in value.EnumerateArray()) { if (!firstItem) builder.Append(','); firstItem = false; Canon(item, builder); }
                builder.Append(']'); break;
            case JsonValueKind.Object:
                // JSON.parse keeps the last duplicate property. Materialize that behavior before sorting.
                var properties = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
                foreach (var property in value.EnumerateObject()) properties[property.Name] = property.Value;
                builder.Append('{'); var firstProperty = true;
                foreach (var property in properties.OrderBy(item => item.Key, StringComparer.Ordinal))
                { if (!firstProperty) builder.Append(','); firstProperty = false; JsonString(property.Key, builder); builder.Append(':'); Canon(property.Value, builder); }
                builder.Append('}'); break;
            default: throw new OfflineUpdateException("$: unsupported JSON value");
        }
    }

    private static void JsonString(string value, StringBuilder builder)
    {
        builder.Append('"');
        foreach (var character in value)
        {
            switch (character)
            {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\b': builder.Append("\\b"); break;
                case '\f': builder.Append("\\f"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    if (character < 0x20) builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    else builder.Append(character);
                    break;
            }
        }
        builder.Append('"');
    }

    private static T Parse<T>(string text, Func<JsonElement, T> parser)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            Need(document.RootElement.ValueKind == JsonValueKind.Object, "$: expected object");
            return parser(document.RootElement);
        }
        catch (OfflineUpdateException) { throw; }
        catch (Exception error) when (error is JsonException or InvalidOperationException or FormatException or OverflowException or ArgumentException)
        { throw new OfflineUpdateException("JSON does not match schema 1: " + error.Message); }
    }

    private static void Keys(JsonElement value, IReadOnlyCollection<string> required, IReadOnlyCollection<string>? optional = null, string path = "$")
    {
        Need(value.ValueKind == JsonValueKind.Object, path + ": expected object");
        optional ??= Array.Empty<string>();
        var names = value.EnumerateObject().Select(item => item.Name).ToHashSet(StringComparer.Ordinal);
        foreach (var item in required) Need(names.Contains(item), path + ": missing field " + item);
        foreach (var item in names) Need(required.Contains(item) || optional.Contains(item), path + ": unknown field " + item);
    }

    private static string Str(JsonElement root, string name) { var value = root.GetProperty(name); Need(value.ValueKind == JsonValueKind.String, name + ": expected string"); return value.GetString()!; }
    private static int Int(JsonElement root, string name)
    {
        var value = root.GetProperty(name);
        var result = 0;
        Need(value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out result), name + ": expected integer");
        return result;
    }
    private static bool Bool(JsonElement root, string name) { var value = root.GetProperty(name); Need(value.ValueKind is JsonValueKind.True or JsonValueKind.False, name + ": expected boolean"); return value.GetBoolean(); }
    private static long Size(JsonElement root, string name, string path)
    {
        var value = root.GetProperty(name);
        long result = 0;
        Need(value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out result) && result is > 0 and <= MaxSafeInteger && result <= MaxArtifactSize, path + "." + name + ": expected positive safe integer within size limit");
        return result;
    }
    private static string Platform(JsonElement root, string path) { var value = Str(root, "platform"); Need(value == "win32", path + ".platform: expected win32"); return value; }
    private static string Arch(JsonElement root, string path) { var value = Str(root, "arch"); Need(value == "x64", path + ".arch: expected x64"); return value; }
    private static string Hash(JsonElement root, string path) { var value = Str(root, "sha256"); Need(ShaRegex().IsMatch(value), path + ".sha256: invalid sha256"); return value; }
    private static string Id(JsonElement root, string name, string path) { var value = Str(root, name); Need(IdRegex().IsMatch(value) && !value.Contains("..", StringComparison.Ordinal), path + "." + name + ": invalid identifier"); return value; }
    private static string Ver(JsonElement root, string name, string path) { var value = Str(root, name); Need(value.Length <= 128 && TryParseSemanticVersion(value, out _), path + "." + name + ": invalid semantic version"); return value; }
    private static string Commit(JsonElement root, string name, string path) { var value = Str(root, name); Need(CommitRegex().IsMatch(value), path + "." + name + ": invalid commit"); return value; }
    private static string Build(JsonElement root, string name, string path) { var value = Str(root, name); Need(IsBuildId(value), path + "." + name + ": invalid build ID"); return value; }
    private static string Time(JsonElement root, string name, string path) { var value = Str(root, name); Need(TryTime(value, out _), path + "." + name + ": invalid timestamp"); return value; }
    private static DateTimeOffset ParseTime(string value)
    {
        var result = default(DateTimeOffset);
        Need(TryTime(value, out result), "invalid timestamp");
        return result;
    }

    private static string Entrypoint(JsonElement root, string name, string path)
    {
        var value = Str(root, name);
        Need(value.Length is > 0 and <= 260, path + "." + name + ": unsafe relative entrypoint");
        Need(value[0] is not '/' and not '\\' && !AbsoluteDriveRegex().IsMatch(value), path + "." + name + ": unsafe relative entrypoint");
        Need(!value.Any(character => character <= 0x1f || character is ':' or '<' or '>' or '"' or '|' or '?' or '*'), path + "." + name + ": unsafe relative entrypoint");
        Need(!value.Split(['/', '\\']).Any(part => part.Length == 0 || part is "." or ".." || part.EndsWith(' ') || part.EndsWith('.')), path + "." + name + ": unsafe relative entrypoint");
        return value;
    }

    private static string TrustedReleaseUrl(JsonElement root, string name, string path, IReadOnlyList<TrustedReleaseSource> sources)
    {
        var value = Str(root, name);
        Need(IsTrustedReleaseUrl(value, sources), path + "." + name + ": outside trusted release sources");
        return value;
    }

    private static IReadOnlyList<TrustedReleaseSource> NormalizeSources(IReadOnlyList<TrustedReleaseSource> sources)
    {
        Need(sources.Count > 0, "trustedSources: must not be empty");
        return sources.Select((source, index) =>
        {
            Need(Uri.TryCreate(source.Origin, UriKind.Absolute, out var origin) && origin.Scheme == Uri.UriSchemeHttps && origin.GetLeftPart(UriPartial.Authority) == source.Origin && origin.AbsolutePath == "/" && origin.Query.Length == 0 && origin.Fragment.Length == 0 && origin.UserInfo.Length == 0, $"trustedSources[{index}].origin: expected HTTPS origin");
            var prefix = source.RepoPathPrefix.TrimEnd('/');
            Need(RepoPrefixRegex().IsMatch(prefix), $"trustedSources[{index}].repoPathPrefix: expected /owner/repository");
            return new TrustedReleaseSource(source.Origin, prefix);
        }).ToArray();
    }

    private static bool IsTrustedReleaseUrl(string value, IReadOnlyList<TrustedReleaseSource> sources)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps || uri.UserInfo.Length != 0 || uri.Fragment.Length != 0) return false;
        var origin = uri.GetLeftPart(UriPartial.Authority);
        return sources.Any(source => origin == source.Origin &&
            (uri.AbsolutePath.StartsWith(source.RepoPathPrefix + "/releases/download/", StringComparison.Ordinal) ||
             uri.AbsolutePath.StartsWith(source.RepoPathPrefix + "/releases/tag/", StringComparison.Ordinal)));
    }

    private static bool TryTime(string value, out DateTimeOffset result)
    {
        result = default;
        var match = TimestampRegex().Match(value);
        if (!match.Success || !int.TryParse(match.Groups[1].Value, out var year) || year < 1000) return false;
        var formats = match.Groups[2].Success
            ? new[] { "yyyy-MM-dd'T'HH:mm:ss." + new string('f', match.Groups[2].Value.Length) + "'Z'" }
            : new[] { "yyyy-MM-dd'T'HH:mm:ss'Z'" };
        return DateTimeOffset.TryParseExact(value, formats, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out result);
    }

    private static bool IsBuildId(string value)
    {
        var match = BuildRegex().Match(value);
        if (!match.Success || !int.TryParse(match.Groups[1].Value, out var year) || year < 1000) return false;
        var timestamp = $"{match.Groups[1].Value}-{match.Groups[2].Value}-{match.Groups[3].Value}T{match.Groups[4].Value}:{match.Groups[5].Value}:{match.Groups[6].Value}Z";
        return TryTime(timestamp, out _);
    }

    private sealed record SemanticVersion(long[] Core, IReadOnlyList<string> Prerelease);
    private static bool TryParseSemanticVersion(string value, out SemanticVersion version)
    {
        version = new([0, 0, 0], Array.Empty<string>());
        var match = SemverRegex().Match(value);
        if (!match.Success) return false;
        var core = new long[3];
        for (var index = 0; index < 3; index++)
            if (!long.TryParse(match.Groups[index + 1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out core[index]) || core[index] > MaxSafeInteger) return false;
        version = new(core, match.Groups[4].Success ? match.Groups[4].Value.Split('.') : Array.Empty<string>());
        return true;
    }

    private static int CompareNumericIdentifiers(string left, string right)
    {
        left = left.TrimStart('0');
        right = right.TrimStart('0');
        if (left.Length == 0) left = "0";
        if (right.Length == 0) right = "0";
        if (left.Length != right.Length) return left.Length > right.Length ? 1 : -1;
        return StringComparer.Ordinal.Compare(left, right) switch { > 0 => 1, < 0 => -1, _ => 0 };
    }
    private static bool IsChannel(string value) => value is "stable" or "beta" or "nightly";
    private static bool Identity(string value)
    {
        if (value == "none") return true;
        var parts = value.Split('/');
        return parts.Length == 3 && TryParseSemanticVersion(parts[0], out _) && IsBuildId(parts[1]) && CommitRegex().IsMatch(parts[2]);
    }
    private static void Need(bool condition, string message) { if (!condition) throw new OfflineUpdateException(message); }

    [GeneratedRegex(@"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$", RegexOptions.CultureInvariant)] private static partial Regex SemverRegex();
    [GeneratedRegex(@"^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([0-9a-f]{7})$", RegexOptions.CultureInvariant)] private static partial Regex BuildRegex();
    [GeneratedRegex(@"^[0-9a-f]{40}$", RegexOptions.CultureInvariant)] private static partial Regex CommitRegex();
    [GeneratedRegex(@"^[0-9a-f]{64}$", RegexOptions.CultureInvariant)] private static partial Regex ShaRegex();
    [GeneratedRegex(@"^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$", RegexOptions.CultureInvariant)] private static partial Regex IdRegex();
    [GeneratedRegex(@"^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,3}))?Z$", RegexOptions.CultureInvariant)] private static partial Regex TimestampRegex();
    [GeneratedRegex(@"^\d+$", RegexOptions.CultureInvariant)] private static partial Regex DigitsRegex();
    [GeneratedRegex(@"^[A-Za-z]:", RegexOptions.CultureInvariant)] private static partial Regex AbsoluteDriveRegex();
    [GeneratedRegex(@"^/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", RegexOptions.CultureInvariant)] private static partial Regex RepoPrefixRegex();
}
