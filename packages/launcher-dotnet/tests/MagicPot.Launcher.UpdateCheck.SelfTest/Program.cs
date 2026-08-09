using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Text.Json;
using MagicPot.Launcher;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

internal static class Program
{
    private static int assertions;

    public static async Task Main()
    {
        var root = Path.Combine(Path.GetTempPath(), "MagicPot.UpdateCheck.SelfTest", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var layout = LauncherLayout.Create(root);
            var active = Installation(root, "1.0.0", "20250101-010101-aaaaaaa", "runtime-a");
            var configuration = Configuration(true);
            var missingFactory = new FakeFactory(Result(Manifest("2.0.0", "20250102-020202-bbbbbbb", "runtime-b")));
            var missing = await LauncherUpdateCheck.RunFromSettingsAsync(layout, active, configuration, missingFactory);
            Equal("manual", missing.Status.Status); Equal(0, missingFactory.CreateCount);
            Equal(3, LauncherSettingsStore.Default.RetainAppVersions); Equal(3, LauncherSettingsStore.Default.RetainNightlyVersions);
            var manualFactory = new FakeFactory(Result(Manifest("2.0.0", "20250102-020202-bbbbbbb", "runtime-b")));
            Equal("manual", (await LauncherUpdateCheck.RunAsync(layout, active, Settings("manual"), configuration, manualFactory)).Status.Status); Equal(0, manualFactory.CreateCount);
            var disabledFactory = new FakeFactory(Result(Manifest("2.0.0", "20250102-020202-bbbbbbb", "runtime-b")));
            Equal("disabled", (await LauncherUpdateCheck.RunAsync(layout, active, Settings("notify-on-launch"), Configuration(false), disabledFactory)).Status.Status); Equal(0, disabledFactory.CreateCount);
            Equal("available", (await Check(layout, active, "notify-on-launch", Manifest("2.0.0", "20250102-020202-bbbbbbb", "runtime-b"))).Status.Status);
            Equal("available", (await Check(layout, active, "notify-on-launch", Manifest("1.0.1", "20250103-030303-0000000", "runtime-z"))).Status.Status);
            var auto = await Check(layout, active, "auto-on-launch", Manifest("2.0.0", "20250102-020202-bbbbbbb", "runtime-b")); Equal("available", auto.Status.Status); True(auto.Status.Status != "installed", "auto check claimed installation");
            Equal("up-to-date", (await Check(layout, active, "notify-on-launch", Manifest("1.0.0", "20250101-010101-aaaaaaa", "runtime-a"))).Status.Status);
            Equal("up-to-date", (await Check(layout, active, "notify-on-launch", Manifest("1.0.0", "20250104-040404-ddddddd", "runtime-z"))).Status.Status);
            Equal("up-to-date", (await Check(layout, active, "notify-on-launch", Manifest("1.0.0", "20250103-030303-0000000", "runtime-z"))).Status.Status);
            Equal("up-to-date", (await Check(layout, active, "notify-on-launch", Manifest("0.9.0", "20250104-040404-ddddddd", "runtime-z"))).Status.Status);
            Equal("unavailable", (await CheckException(layout, active, new ChannelManifestClientException("offline", ChannelManifestFailureKind.Unavailable))).Status.Status);
            Equal("failed", (await CheckException(layout, active, new ChannelManifestClientException("bad"))).Status.Status);
            File.WriteAllText(Path.Combine(root, "settings.json"), "{}");
            var invalidFactory = new FakeFactory(Result(Manifest("2.0.0", "20250102-020202-bbbbbbb", "runtime-b")));
            Equal("failed", (await LauncherUpdateCheck.RunFromSettingsAsync(layout, active, configuration, invalidFactory)).Status.Status); Equal(0, invalidFactory.CreateCount);
            True(LauncherUpdateCheck.IsEnvironmentVersion("1.2.3-alpha.1+build"), "valid environment version rejected");
            True(!LauncherUpdateCheck.IsEnvironmentVersion("01.2.3"), "leading-zero environment version accepted");
            True(!LauncherUpdateCheck.IsEnvironmentVersion("1.2"), "short environment version accepted");
            Environment.SetEnvironmentVariable("MAGICPOT_UPDATE_OLD", "parent");
            Environment.SetEnvironmentVariable("MagicPot_Update_Version", "parent-version");
            Environment.SetEnvironmentVariable("magicpot_update_status", "parent-status");
            Environment.SetEnvironmentVariable("MaGiCpOt_UpDaTe_PrivateTail", "parent-private");
            var availableInfo = LauncherEngine.BuildProcessStartInfo(active, Array.Empty<string>(), "token", root, new("notify-on-launch", "available", "stable", "2.0.0"));
            True(!HasEnvironmentKey(availableInfo, "MAGICPOT_UPDATE_OLD"), "parent update variable survived");
            True(!HasEnvironmentKey(availableInfo, "MaGiCpOt_UpDaTe_PrivateTail"), "mixed-case nonstandard update variable survived");
            Equal(4, UpdateEnvironmentKeyCount(availableInfo));
            foreach (var key in new[] { "MAGICPOT_UPDATE_MODE", "MAGICPOT_UPDATE_STATUS", "MAGICPOT_UPDATE_CHANNEL", "MAGICPOT_UPDATE_VERSION" })
                True(HasExactEnvironmentKey(availableInfo, key), key + " was not canonical uppercase");
            Equal("notify-on-launch", availableInfo.Environment["MAGICPOT_UPDATE_MODE"]!); Equal("available", availableInfo.Environment["MAGICPOT_UPDATE_STATUS"]!);
            Equal("stable", availableInfo.Environment["MAGICPOT_UPDATE_CHANNEL"]!); Equal("2.0.0", availableInfo.Environment["MAGICPOT_UPDATE_VERSION"]!);
            foreach (var status in new[] { "manual", "disabled", "up-to-date", "unavailable", "failed" })
            {
                var info = LauncherEngine.BuildProcessStartInfo(active, Array.Empty<string>(), "token", root, new("notify-on-launch", status, "stable", "9.9.9"));
                True(!info.Environment.ContainsKey("MAGICPOT_UPDATE_VERSION"), status + " leaked update version");
            }
            var failedInfo = LauncherEngine.BuildProcessStartInfo(active, Array.Empty<string>(), "token", root, new("notify-on-launch", "failed", "stable"));
            Equal(active.AppEntrypoint, failedInfo.FileName);
            Console.WriteLine("PASS: " + assertions + " assertions");
        }
        finally
        {
            Environment.SetEnvironmentVariable("MAGICPOT_UPDATE_OLD", null);
            Environment.SetEnvironmentVariable("MagicPot_Update_Version", null);
            Environment.SetEnvironmentVariable("magicpot_update_status", null);
            Environment.SetEnvironmentVariable("MaGiCpOt_UpDaTe_PrivateTail", null);
            try { Directory.Delete(root, true); } catch (Exception) { }
        }
    }

    private const string KeyId = "update-check-selftest";
    private static readonly Ed25519PrivateKeyParameters PrivateKey = new(Enumerable.Range(1, 32).Select(static value => (byte)value).ToArray(), 0);
    private static readonly byte[] PublicKey = PrivateKey.GeneratePublicKey().GetEncoded();
    private static readonly IChannelManifestSignatureVerifier Verifier = new Ed25519ChannelManifestSignatureVerifier(new Dictionary<string, byte[]> { [KeyId] = PublicKey });

    private static Task<UpdateCheckOutcome> Check(LauncherLayout layout, ValidatedInstallation active, string mode, VerifiedChannelManifestProof proof) => LauncherUpdateCheck.RunAsync(layout, active, Settings(mode), Configuration(true), new FakeFactory(Result(proof)));
    private static Task<UpdateCheckOutcome> CheckException(LauncherLayout layout, ValidatedInstallation active, Exception exception) => LauncherUpdateCheck.RunAsync(layout, active, Settings("notify-on-launch"), Configuration(true), new ExceptionFactory(exception));
    private static LauncherSettingsV1 Settings(string mode) => new(1, mode, "stable", 3, 3, false);
    private static LauncherUpdateConfiguration Configuration(bool enabled) => new(enabled, "1.0.0", new Dictionary<string, string> { ["stable"] = "https://example.test/stable.json" }, OfflineUpdateDecision.DefaultTrustedReleaseSources, new Dictionary<string, byte[]> { [KeyId] = PublicKey });
    private static ChannelManifestLoadResult Result(VerifiedChannelManifestProof proof) => new(proof, "fake");
    private static VerifiedChannelManifestProof Manifest(string version, string build, string runtime)
    {
        const string created = "2025-01-01T00:00:00Z";
        var commit = build[^7..] + new string('a', 33);
        var releaseUrl = "https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/download/selftest/";
        var unsigned = new Dictionary<string, object?>
        {
            ["schema"] = 1,
            ["channel"] = "stable",
            ["generatedAt"] = created,
            ["releases"] = new object[]
            {
                new Dictionary<string, object?>
                {
                    ["version"] = version,
                    ["buildId"] = build,
                    ["commitSha"] = commit,
                    ["publishedAt"] = created,
                    ["releaseNotesUrl"] = "https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/tag/selftest",
                    ["minimumLauncherVersion"] = "1.0.0",
                    ["artifacts"] = new Dictionary<string, object?>
                    {
                        ["app"] = new Dictionary<string, object?>
                        {
                            ["kind"] = "app", ["version"] = version, ["buildId"] = build, ["commitSha"] = commit,
                            ["runtimeId"] = runtime, ["platform"] = "win32", ["arch"] = "x64", ["url"] = releaseUrl + "app.zip",
                            ["sha256"] = new string('b', 64), ["size"] = 1, ["unpackedSize"] = 1, ["entrypoint"] = "app.exe", ["createdAt"] = created
                        },
                        ["runtime"] = new Dictionary<string, object?>
                        {
                            ["kind"] = "runtime", ["runtimeId"] = runtime, ["platform"] = "win32", ["arch"] = "x64", ["url"] = releaseUrl + "runtime.zip",
                            ["sha256"] = new string('c', 64), ["size"] = 1, ["unpackedSize"] = 1, ["entrypoint"] = "python.exe", ["createdAt"] = created
                        }
                    }
                }
            }
        };
        var placeholder = new Dictionary<string, object?>(unsigned)
        {
            ["signature"] = new Dictionary<string, object?> { ["algorithm"] = "ed25519", ["keyId"] = KeyId, ["value"] = Convert.ToBase64String(new byte[64]) }
        };
        var parsed = OfflineUpdateDecision.ParseChannelManifest(JsonSerializer.Serialize(placeholder), "stable");
        var payload = OfflineUpdateDecision.SigningPayload(parsed);
        var signer = new Ed25519Signer();
        signer.Init(true, PrivateKey);
        signer.BlockUpdate(payload, 0, payload.Length);
        var signed = new Dictionary<string, object?>(unsigned)
        {
            ["signature"] = new Dictionary<string, object?> { ["algorithm"] = "ed25519", ["keyId"] = KeyId, ["value"] = Convert.ToBase64String(signer.GenerateSignature()) }
        };
        return OfflineUpdateDecision.ParseAndVerifyChannelManifest(JsonSerializer.Serialize(signed), "stable", Verifier);
    }
    private static ValidatedInstallation Installation(string root, string version, string build, string runtime)
    {
        var appDirectory = Path.Combine(root, "app"); Directory.CreateDirectory(appDirectory); var entrypoint = Path.Combine(appDirectory, "app.exe"); File.WriteAllText(entrypoint, string.Empty);
        var app = new InstalledAppManifestV1(1, "app", version, build, new string('a', 40), "win32", "x64", runtime, "app.exe", "2025-01-01T00:00:00Z", 1, null);
        var runtimeManifest = new InstalledRuntimeManifestV1(1, "runtime", runtime, "win32", "x64", "2025-01-01T00:00:00Z", new("python.exe", "main.py"), 1, null);
        return new(app, runtimeManifest, appDirectory, root, entrypoint, new(0, 0, 0));
    }
    private static bool HasEnvironmentKey(System.Diagnostics.ProcessStartInfo info, string expected) => info.Environment.Keys.Any(key => string.Equals(key, expected, StringComparison.OrdinalIgnoreCase));
    private static bool HasExactEnvironmentKey(System.Diagnostics.ProcessStartInfo info, string expected) => info.Environment.Keys.Any(key => string.Equals(key, expected, StringComparison.Ordinal));
    private static int UpdateEnvironmentKeyCount(System.Diagnostics.ProcessStartInfo info) => info.Environment.Keys.Count(key => key.StartsWith("MAGICPOT_UPDATE_", StringComparison.OrdinalIgnoreCase));
    private static void Equal(string expected, string actual) { if (!string.Equals(expected, actual, StringComparison.Ordinal)) throw new Exception($"Expected {expected}, got {actual}"); assertions++; }
    private static void Equal(int expected, int actual) { if (expected != actual) throw new Exception($"Expected {expected}, got {actual}"); assertions++; }
    private static void True(bool value, string message) { if (!value) throw new Exception(message); assertions++; }

    private sealed class FakeFactory : IChannelManifestClientFactory
    {
        private readonly ChannelManifestLoadResult result;
        public FakeFactory(ChannelManifestLoadResult result) => this.result = result;
        public int CreateCount { get; private set; }
        public IChannelManifestClient Create(ChannelManifestClientOptions options) { CreateCount++; return new FakeClient(result); }
    }
    private sealed class FakeClient : IChannelManifestClient
    {
        private readonly ChannelManifestLoadResult result;
        public FakeClient(ChannelManifestLoadResult result) => this.result = result;
        public Task<ChannelManifestLoadResult> LoadAsync(CancellationToken cancellationToken = default) => Task.FromResult(result);
        public void Dispose() { }
    }
    private sealed class ExceptionFactory : IChannelManifestClientFactory
    {
        private readonly Exception exception;
        public ExceptionFactory(Exception exception) => this.exception = exception;
        public IChannelManifestClient Create(ChannelManifestClientOptions options) => new ExceptionClient(exception);
    }
    private sealed class ExceptionClient : IChannelManifestClient
    {
        private readonly Exception exception;
        public ExceptionClient(Exception exception) => this.exception = exception;
        public Task<ChannelManifestLoadResult> LoadAsync(CancellationToken cancellationToken = default) => Task.FromException<ChannelManifestLoadResult>(exception);
        public void Dispose() { }
    }
}
