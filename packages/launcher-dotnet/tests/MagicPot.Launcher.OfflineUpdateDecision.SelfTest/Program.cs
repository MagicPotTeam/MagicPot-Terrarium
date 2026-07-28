using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using MagicPot.Launcher;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

internal static class Program
{
    private const string Signature = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    private const string CommitA = "abcdef0123456789abcdef0123456789abcdef01";
    private const string CommitB = "1234567123456789abcdef0123456789abcdef01";

    private static void Main()
    {
        Run("Node schema and identities", SchemaAndIdentities);
        Run("optional runtime and selection", RuntimeSelection);
        Run("trusted release URLs", TrustedUrls);
        Run("entrypoint parity", Entrypoints);
        Run("canonical/signing payload vector", SigningVector);
        Run("policy and high-water", PolicyAndHighWater);
        Run("Ed25519 signature verifier", Ed25519Signatures);
        Run("fail-closed signature verifier", Signatures);
        Run("verified proof capability boundary", VerifiedProofBoundary);
        Console.WriteLine("MagicPot.Launcher offline update decision self-test passed");
    }

    private static void SchemaAndIdentities()
    {
        var manifest = Parse(Release());
        var app = manifest.Releases[0].Artifacts.App;
        Equal("1.0.0", app.Version, "app version");
        Equal(CommitA, app.CommitSha, "app commit");
        Equal("python\\python.exe", manifest.Releases[0].Artifacts.Runtime!.Entrypoint, "runtime has one entrypoint and preserves separators");
        Reject(() => Parse(Release(extraApp: ",\"pythonEntrypoint\":\"python.exe\"")), "removed app field");
        Reject(() => Parse(Release(extraRuntime: ",\"comfyuiEntrypoint\":\"main.py\"")), "removed runtime field");
        Reject(() => Parse(Release(appVersion: "1.0.1")), "app/release version mismatch");
        Reject(() => Parse(Release(appBuildId: "20250102-010203-abcdef0")), "app/release build mismatch");
        Reject(() => Parse(Release(appCommit: CommitB)), "app/release commit mismatch");
        Reject(() => Parse(Release(runtimeArtifactId: "runtime-b")), "runtime mismatch");
        Reject(() => Parse(Release(buildId: "20250101-010203-1234567")), "release build/commit mismatch");
        Reject(() => Parse(Release(appBuildId: "20250101-010203-1234567")), "app build/commit mismatch");
        Reject(() => Parse(Release(appSize: "9007199254740992")), "JS unsafe integer");
        Reject(() => Parse(Release(appSize: "1099511627777")), "one TiB limit");
    }

    private static void RuntimeSelection()
    {
        var withoutRuntime = Parse(Release(includeRuntime: false));
        True(withoutRuntime.Releases[0].Artifacts.Runtime is null, "runtime is optional while parsing");
        Equal<SelectedArtifactsV1?>(null, OfflineUpdateDecision.SelectLatestArtifacts(withoutRuntime), "release without runtime is not selectable");

        var olderWithRuntime = Release(version: "1.0.0", buildId: "20250101-010203-abcdef0", publishedAt: "2025-01-01T00:00:00Z");
        var newerWithoutRuntime = Release(version: "1.1.0", buildId: "20250102-010203-1234567", commit: CommitB, publishedAt: "2025-01-02T00:00:00Z", includeRuntime: false);
        var selected = OfflineUpdateDecision.SelectLatestArtifacts(Parse(olderWithRuntime + "," + newerWithoutRuntime));
        Equal("1.1.0", selected!.Release.Version, "newer app reuses runtime from another release");
        Equal("runtime-a", selected.Runtime.RuntimeId, "selected runtime is non-nullable and matching");

        var first = Parse(Release(runtimeEntrypoint: "runtime/first.exe")).Releases[0];
        var second = Parse(Release(runtimeEntrypoint: "runtime/second.exe")).Releases[0];
        var appOnly = Parse(newerWithoutRuntime).Releases[0];
        var duplicateRuntimeManifest = withoutRuntime with { Releases = [first, second, appOnly] };
        var overwritten = OfflineUpdateDecision.SelectLatestArtifacts(duplicateRuntimeManifest);
        Equal("runtime/second.exe", overwritten!.Runtime.Entrypoint, "later duplicate runtimeId overwrites the earlier runtime deterministically");

        var highOlder = Release(version: "2.0.0", buildId: "20250101-010203-abcdef0", publishedAt: "2025-01-01T00:00:00Z");
        var lowNewer = Release(version: "1.9.0", buildId: "20250102-010203-1234567", commit: CommitB, publishedAt: "2025-01-02T00:00:00Z", runtimeId: "runtime-b");
        Equal("2.0.0", OfflineUpdateDecision.SelectLatestArtifacts(Parse(lowNewer + "," + highOlder))!.Release.Version, "SemVer outranks publication time");

        var provider = Parse(olderWithRuntime).Releases[0];
        var filteredRuntimeManifest = withoutRuntime with { Releases = [provider, appOnly] };
        var filteredRuntime = OfflineUpdateDecision.SelectLatestArtifacts(filteredRuntimeManifest, "win32", "x64", release => release.Version == "1.1.0");
        Equal("1.1.0", filteredRuntime!.Release.Version, "policy only filters app candidates");
        Equal("runtime-a", filteredRuntime.Runtime.RuntimeId, "filtered release can still provide runtime");

        Equal(1, OfflineUpdateDecision.CompareSemanticVersions("1.0.0-alpha.9007199254740993", "1.0.0-alpha.9007199254740992"), "long numeric prerelease precision");
        Equal(0, OfflineUpdateDecision.CompareSemanticVersions("1.0.0-alpha.0002", "1.0.0-alpha.2"), "numeric prerelease leading zeroes");
        Equal<int?>(null, OfflineUpdateDecision.CompareSemanticVersions("9007199254740992.0.0", "1.0.0"), "unsafe core rejected");
    }

    private static void TrustedUrls()
    {
        Parse(Release(artifactPath: "tag"));
        Reject(() => Parse(Release(releaseNotesUrl: "https://example.test/releases/tag/v1")), "untrusted release notes");
        Reject(() => Parse(Release(releaseNotesUrl: "https://user@github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/tag/v1")), "release notes credentials");
        Reject(() => Parse(Release(releaseNotesUrl: "https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/tag/v1#x")), "release notes fragment");
        Reject(() => Parse(Release(appUrl: "http://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/download/v1/app.zip")), "artifact HTTPS");
        Reject(() => Parse(Release(appUrl: "https://github.com/MagicPotTeam/other/releases/download/v1/app.zip")), "artifact repo prefix");
    }

    private static void Entrypoints()
    {
        Parse(Release(appEntrypoint: "CON/MagicPot.EXE", runtimeEntrypoint: "runtime/main.py"));
        foreach (var invalid in new[] { "", "/MagicPot.exe", "C:MagicPot.exe", "a//MagicPot.exe", "a\\\\MagicPot.exe", "./MagicPot.exe", "../MagicPot.exe", "a /MagicPot.exe", "a./MagicPot.exe", "a?/MagicPot.exe", "a\n/MagicPot.exe" })
            Reject(() => Parse(Release(appEntrypoint: invalid)), "invalid app entrypoint " + JsonSerializer.Serialize(invalid));
        Reject(() => Parse(Release(appEntrypoint: new string('a', 257) + ".exe")), "entrypoint over 260");
        Reject(() => Parse(Release(appEntrypoint: "MagicPot.bin")), "app extension");
        Parse(Release(runtimeEntrypoint: "runtime/no-extension"));
        Reject(() => Parse(Release(runtimeEntrypoint: "runtime/../python.exe")), "runtime uses same path rules");
    }

    private static void SigningVector()
    {
        var withRuntime = Parse(Release());
        var payload = Encoding.UTF8.GetString(OfflineUpdateDecision.SigningPayload(withRuntime));
        const string expected = "{\"channel\":\"stable\",\"generatedAt\":\"2025-01-03T00:00:00Z\",\"releases\":[{\"artifacts\":{\"app\":{\"arch\":\"x64\",\"buildId\":\"20250101-010203-abcdef0\",\"commitSha\":\"abcdef0123456789abcdef0123456789abcdef01\",\"createdAt\":\"2025-01-01T01:02:03.123Z\",\"entrypoint\":\"MagicPot.exe\",\"kind\":\"app\",\"platform\":\"win32\",\"runtimeId\":\"runtime-a\",\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"size\":10,\"unpackedSize\":20,\"url\":\"https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/download/v1/app.zip\",\"version\":\"1.0.0\"},\"runtime\":{\"arch\":\"x64\",\"createdAt\":\"2025-01-01T01:02:03.123Z\",\"entrypoint\":\"python\\\\python.exe\",\"kind\":\"runtime\",\"platform\":\"win32\",\"runtimeId\":\"runtime-a\",\"sha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"size\":30,\"unpackedSize\":40,\"url\":\"https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/download/v1/runtime.zip\"}},\"buildId\":\"20250101-010203-abcdef0\",\"commitSha\":\"abcdef0123456789abcdef0123456789abcdef01\",\"minimumLauncherVersion\":\"1.0.0\",\"publishedAt\":\"2025-01-01T01:02:03.123Z\",\"releaseNotesUrl\":\"https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/tag/v1\",\"version\":\"1.0.0\"}],\"schema\":1}";
        Equal(expected, payload, "exact Node-compatible canonical payload");
        var withoutRuntime = Encoding.UTF8.GetString(OfflineUpdateDecision.SigningPayload(Parse(Release(includeRuntime: false))));
        True(!withoutRuntime.Contains("\"runtime\":", StringComparison.Ordinal), "optional runtime is omitted, not null");
        Equal("{\"a\":1,\"z\":2}", OfflineUpdateDecision.CanonicalJson("{\"z\":2,\"a\":1}"), "canonical key ordering");
        Reject(() => OfflineUpdateDecision.CanonicalJson("1.5"), "test-only arbitrary canonical API is intentionally limited to safe integers");
        Reject(() => OfflineUpdateDecision.CanonicalJson("9007199254740992"), "canonical unsafe integer");
    }

    private static void PolicyAndHighWater()
    {
        var stable = Release();
        var prerelease = Release(version: "2.0.0-beta.1", buildId: "20250102-010203-1234567", commit: CommitB, publishedAt: "2025-01-02T00:00:00Z", minimum: "2.0.0", runtimeId: "runtime-b");
        var manifest = Parse(stable + "," + prerelease);
        Equal("1.0.0", OfflineUpdateDecision.SelectLatestArtifactsWithPolicy(manifest, new(1, "notify-on-launch", "stable", 3, 7, false), "2.0.0")!.Release.Version, "prerelease policy");
        var (raw, verified) = SignedProof(stable);
        var selected = OfflineUpdateDecision.SelectLatestArtifacts(verified.Manifest);
        var high = OfflineUpdateDecision.AcceptHighWater(verified, null, selected);
        Equal(OfflineUpdateDecision.Sha256(raw), high.Digest, "high-water raw digest");
    }

    private static void Ed25519Signatures()
    {
        // RFC 8032 section 7.1, TEST 1: empty message.
        var publicKey = Convert.FromHexString("D75A980182B10AB7D54BFED3C964073A0EE172F3DAA62325AF021A68F707511A");
        var rfcSignature = Convert.FromHexString("E5564300C360AC729086E2CC806E828A84877F1EB8E5D974D873E065224901555FB8821590A33BACC61E39701CF9B46BD25BF5F0595BBE24655141438E7A100B");
        var verifier = new Ed25519ChannelManifestSignatureVerifier(new Dictionary<string, byte[]> { ["rfc8032"] = publicKey });
        Verify(true, verifier, [], new("ed25519", "rfc8032", Convert.ToBase64String(rfcSignature)), "RFC 8032 vector");
        var badSignature = (byte[])rfcSignature.Clone();
        badSignature[0] ^= 1;
        Verify(false, verifier, [], new("ed25519", "rfc8032", Convert.ToBase64String(badSignature)), "wrong signature");
        Verify(false, verifier, [], new("ed25519", "unknown", Convert.ToBase64String(rfcSignature)), "unknown key");
        Verify(false, new Ed25519ChannelManifestSignatureVerifier(new Dictionary<string, byte[]> { ["short"] = new byte[31] }), [], new("ed25519", "short", Convert.ToBase64String(rfcSignature)), "wrong public key length");
        Verify(false, verifier, [], new("ed25519", "rfc8032", Convert.ToBase64String(new byte[63])), "wrong signature length");
        Verify(false, verifier, [], new("ed25519", "rfc8032", "not base64"), "invalid base64");
        Verify(false, verifier, [], new("Ed25519", "rfc8032", Convert.ToBase64String(rfcSignature)), "algorithm is strict");

        var privateKey = new Ed25519PrivateKeyParameters(Convert.FromHexString("9D61B19DEFFD5A60BA844AF492EC2CC44449C5697B326919703BAC031CAE7F60"), 0);
        const string keyId = "manifest-test";
        var unsignedRaw = Manifest(Release());
        var parsed = OfflineUpdateDecision.ParseChannelManifest(unsignedRaw, "stable");
        var signer = new Ed25519Signer();
        signer.Init(true, privateKey);
        var payload = OfflineUpdateDecision.SigningPayload(parsed);
        signer.BlockUpdate(payload, 0, payload.Length);
        var signedRaw = Manifest(Release(), Convert.ToBase64String(signer.GenerateSignature()), keyId);
        var productionVerifier = new Ed25519ChannelManifestSignatureVerifier(new Dictionary<string, string>
        {
            [keyId] = Convert.ToBase64String(privateKey.GeneratePublicKey().GetEncoded())
        });
        OfflineUpdateDecision.ParseAndVerifyChannelManifest(signedRaw, "stable", productionVerifier);
        Reject(() => OfflineUpdateDecision.ParseAndVerifyChannelManifest(signedRaw.Replace("2025-01-03T00:00:00Z", "2025-01-04T00:00:00Z", StringComparison.Ordinal), "stable", productionVerifier), "tampered manifest signature");
    }

    private static void Signatures()
    {
        var raw = Manifest(Release());
        Reject(() => OfflineUpdateDecision.ParseAndVerifyChannelManifest(raw, "stable"), "default production verifier fails closed");
        _ = SignedProof(Release());
    }

    private static void VerifiedProofBoundary()
    {
        var (_, proof) = SignedProof(Release());
        True(proof.Manifest.Releases is not ChannelReleaseV1[], "verified releases expose an array");
        var list = (IList<ChannelReleaseV1>)proof.Manifest.Releases;
        try { list[0] = list[0] with { Version = "9.9.9" }; throw new Exception("verified releases were mutable"); }
        catch (NotSupportedException) { }
        var selected = proof.SelectLatestArtifacts() ?? throw new Exception("verified selection missing");
        _ = proof.CreateAppRequest(selected);
        var (_, other) = SignedProof(Release());
        Reject(() => other.CreateAppRequest(selected), "selection from another proof");
    }

    private static (string Raw, VerifiedChannelManifestProof Proof) SignedProof(string releases)
    {
        var privateKey = new Ed25519PrivateKeyParameters(Enumerable.Range(1, 32).Select(static value => (byte)value).ToArray(), 0);
        const string keyId = "proof-test";
        var unsigned = Manifest(releases, Signature, keyId);
        var payload = OfflineUpdateDecision.SigningPayload(OfflineUpdateDecision.ParseChannelManifest(unsigned, "stable"));
        var signer = new Ed25519Signer();
        signer.Init(true, privateKey);
        signer.BlockUpdate(payload, 0, payload.Length);
        var raw = Manifest(releases, Convert.ToBase64String(signer.GenerateSignature()), keyId);
        var verifier = new Ed25519ChannelManifestSignatureVerifier(new Dictionary<string, byte[]> { [keyId] = privateKey.GeneratePublicKey().GetEncoded() });
        return (raw, OfflineUpdateDecision.ParseAndVerifyChannelManifest(raw, "stable", verifier));
    }

    private static ChannelManifestV1 Parse(string releases) => OfflineUpdateDecision.ParseChannelManifest(Manifest(releases), "stable");
    private static string Manifest(string releases, string signature = Signature, string keyId = "test-key") => "{\"schema\":1,\"channel\":\"stable\",\"generatedAt\":\"2025-01-03T00:00:00Z\",\"releases\":[" + releases + "],\"signature\":{\"algorithm\":\"ed25519\",\"keyId\":" + J(keyId) + ",\"value\":" + J(signature) + "}}";

    private static string Release(string version = "1.0.0", string buildId = "20250101-010203-abcdef0", string commit = CommitA, string publishedAt = "2025-01-01T01:02:03.123Z", string minimum = "1.0.0", string runtimeId = "runtime-a", string? runtimeArtifactId = null, bool includeRuntime = true, string artifactPath = "download", string? releaseNotesUrl = null, string? appUrl = null, string appEntrypoint = "MagicPot.exe", string runtimeEntrypoint = "python\\python.exe", string? appVersion = null, string? appBuildId = null, string? appCommit = null, string appSize = "10", string extraApp = "", string extraRuntime = "")
    {
        runtimeArtifactId ??= runtimeId;
        appVersion ??= version;
        appBuildId ??= buildId;
        appCommit ??= commit;
        releaseNotesUrl ??= "https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/tag/v1";
        appUrl ??= "https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/" + artifactPath + "/v1/app.zip";
        var runtime = includeRuntime ? ",\"runtime\":{\"kind\":\"runtime\",\"runtimeId\":" + J(runtimeArtifactId) + ",\"platform\":\"win32\",\"arch\":\"x64\",\"url\":\"https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/" + artifactPath + "/v1/runtime.zip\",\"sha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"size\":30,\"unpackedSize\":40,\"entrypoint\":" + J(runtimeEntrypoint) + ",\"createdAt\":" + J(publishedAt) + extraRuntime + "}" : string.Empty;
        return "{\"version\":" + J(version) + ",\"buildId\":" + J(buildId) + ",\"commitSha\":" + J(commit) + ",\"publishedAt\":" + J(publishedAt) + ",\"releaseNotesUrl\":" + J(releaseNotesUrl) + ",\"minimumLauncherVersion\":" + J(minimum) + ",\"artifacts\":{\"app\":{\"kind\":\"app\",\"version\":" + J(appVersion) + ",\"buildId\":" + J(appBuildId) + ",\"commitSha\":" + J(appCommit) + ",\"runtimeId\":" + J(runtimeId) + ",\"platform\":\"win32\",\"arch\":\"x64\",\"url\":" + J(appUrl) + ",\"sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"size\":" + appSize + ",\"unpackedSize\":20,\"entrypoint\":" + J(appEntrypoint) + ",\"createdAt\":" + J(publishedAt) + extraApp + "}" + runtime + "}}";
    }

    private static string J(string value) => JsonSerializer.Serialize(value);
    private static void Run(string name, Action test) { test(); Console.WriteLine("PASS " + name); }
    private static void True(bool value, string message) { if (!value) throw new Exception(message); }
    private static void Equal<T>(T expected, T actual, string message) { if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new Exception(message + ": expected " + expected + ", got " + actual); }
    private static void Reject(Action action, string message) { try { action(); } catch (OfflineUpdateException) { return; } throw new Exception("expected rejection: " + message); }
    private static void Verify(bool expected, IChannelManifestSignatureVerifier verifier, byte[] payload, ManifestSignatureV1 signature, string message)
    {
        var actual = verifier.Verify(payload, signature, out var error);
        Equal(expected, actual, message + (actual ? string.Empty : ": " + error));
    }

}
