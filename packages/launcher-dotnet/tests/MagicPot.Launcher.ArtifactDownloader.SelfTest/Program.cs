using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MagicPot.Launcher;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

internal static class Program
{
    private static readonly byte[] Payload = Encoding.UTF8.GetBytes("verified artifact payload");
    private static readonly byte[] RuntimePayload = Encoding.UTF8.GetBytes("verified runtime payload");
    private static readonly byte[] SeedA = Enumerable.Range(1, Ed25519PrivateKeyParameters.KeySize).Select(static value => (byte)value).ToArray();
    private static readonly byte[] SeedB = Enumerable.Range(101, Ed25519PrivateKeyParameters.KeySize).Select(static value => (byte)value).ToArray();
    private static int unique;

    public static async Task<int> Main()
    {
        var tests = new (string, Func<Task>)[]
        {
            ("public API/capability", PublicApiAsync), ("success/cache/metadata", SuccessAsync),
            ("canonical cache key", CanonicalCacheKeyAsync), ("identity isolation", IdentityIsolationAsync), ("runtime identity", RuntimeIdentityAsync),
            ("lease/path TOCTOU", LeaseAsync), ("tamper", TamperAsync), ("validation", ValidationAsync),
            ("transport/cancel/cleanup", TransportAsync), ("concurrency", ConcurrencyAsync),
            ("metadata corruption/conflict", MetadataAsync), ("link safety", LinkAsync)
        };
        foreach (var test in tests)
        {
            try { await test.Item2().ConfigureAwait(false); Console.WriteLine("PASS " + test.Item1); }
            catch (SkipException exception) { Console.WriteLine("SKIP " + test.Item1 + ": " + exception.Message); }
            catch (Exception exception) { Console.Error.WriteLine("FAIL " + test.Item1 + ": " + exception); return 1; }
        }
        return 0;
    }

    private static Task PublicApiAsync()
    {
        Need(typeof(ArtifactDownloader).IsNotPublic && typeof(ArtifactDownloader).IsSealed, "ArtifactDownloader must be internal sealed");
        var downloads = typeof(ArtifactDownloader).GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
            .Where(static method => method.Name == "DownloadAsync").ToArray();
        Need(downloads.Length == 1, "unexpected DownloadAsync overload count");
        Need(downloads[0].IsAssembly && downloads[0].GetParameters()[0].ParameterType == typeof(VerifiedArtifactRequest), "DownloadAsync must internally accept only the verified capability");
        Need(downloads.All(static method => method.GetParameters()[0].ParameterType != typeof(AppArtifactV1) && method.GetParameters()[0].ParameterType != typeof(RuntimeArtifactV1)), "plain artifact DTO overload remains");
        Need(typeof(VerifiedArtifactRequest).GetConstructors(BindingFlags.Instance | BindingFlags.Public).Length == 0, "verified request is publicly constructible");
        Need(typeof(ArtifactDownloadIdentity).GetConstructors(BindingFlags.Instance | BindingFlags.Public).Length == 0, "identity is publicly constructible");

        var first = Fixture.Create();
        var other = Fixture.Create(appUrl: ReleaseUrl("other.zip"), buildTime: "20250102-000000", commitSha: new string('1', 40));
        var ordinaryDto = new SelectedArtifactsV1(first.Selection.Release, first.Selection.App with { Entrypoint = "tampered.exe" }, first.Selection.Runtime);
        NeedThrows<OfflineUpdateException>(() => first.Proof.CreateRequests(ordinaryDto));
        NeedThrows<OfflineUpdateException>(() => first.Proof.CreateRequests(other.Selection));
        return Task.CompletedTask;
    }

    private static async Task SuccessAsync()
    {
        var fixture = Fixture.Create();
        using var scope = new Scope(); var transport = new FakeTransport(request => Response(Payload, requestUri: request.RequestUri)); using var downloader = scope.Downloader(transport); string path;
        await using (var first = await downloader.DownloadAsync(fixture.AppRequest).ConfigureAwait(false))
        {
            var app = fixture.Selection.App; var identity = first.Identity;
            Need(!first.CacheHit && !first.Stream.CanWrite && (await ReadAllAsync(first.Stream)).SequenceEqual(Payload), "first download/read-only bytes");
            Need(first.Kind == app.Kind && identity.Kind == app.Kind && identity.Platform == app.Platform && identity.Arch == app.Arch && identity.Url == app.Url && identity.Sha256 == app.Sha256 && identity.Size == app.Size && identity.UnpackedSize == app.UnpackedSize && identity.Entrypoint == app.Entrypoint && identity.CreatedAt == app.CreatedAt && identity.Version == app.Version && identity.BuildId == app.BuildId && identity.CommitSha == app.CommitSha && identity.RuntimeId == app.RuntimeId, "lease identity not derived from proof artifact");
            Need(identity.ManifestRawDigest == fixture.Proof.RawManifestSha256 && identity.SigningPayloadDigest == fixture.Proof.SigningPayloadSha256 && identity.SignatureKeyId == fixture.Proof.SignatureKeyId && identity.VerifierIdentity == fixture.Proof.VerifierIdentity, "proof identity missing"); path = first.Path;
        }
        await using (var hit = await downloader.DownloadAsync(fixture.AppRequest)) Need(hit.CacheHit && transport.Calls == 1 && (await ReadAllAsync(hit.Stream)).SequenceEqual(Payload), "zero-network hit");
        File.Delete(path + ".metadata.json"); await using var rebuilt = await downloader.DownloadAsync(fixture.AppRequest); Need(rebuilt.CacheHit && transport.Calls == 1 && File.Exists(path + ".metadata.json"), "metadata rebuild");
        var metadata = File.ReadAllText(path + ".metadata.json"); Need(metadata.Contains(fixture.Proof.RawManifestSha256, StringComparison.Ordinal) && metadata.Contains(fixture.Selection.App.BuildId, StringComparison.Ordinal), "metadata omitted proof/artifact identity");
    }

    private static async Task CanonicalCacheKeyAsync()
    {
        var fixture = Fixture.Create(); using var firstScope = new Scope(); using var firstDownloader = firstScope.Downloader(new FakeTransport(request => Response(Payload, requestUri: request.RequestUri))); await using var first = await firstDownloader.DownloadAsync(fixture.AppRequest);
        using var secondScope = new Scope(); using var secondDownloader = secondScope.Downloader(new FakeTransport(request => Response(Payload, requestUri: request.RequestUri))); await using var second = await secondDownloader.DownloadAsync(fixture.AppRequest);
        Need(Path.GetFileName(first.Path) == Path.GetFileName(second.Path), "canonical proof cache key is not deterministic");
    }

    private static async Task IdentityIsolationAsync()
    {
        using var scope = new Scope(); var transport = new FakeTransport(request => Response(Payload, requestUri: request.RequestUri)); using var downloader = scope.Downloader(transport);
        var fixtures = new[]
        {
            Fixture.Create(), Fixture.Create(appUrl: ReleaseUrl("b.zip")), Fixture.Create(buildTime: "20250102-000000", commitSha: new string('1', 40)),
            Fixture.Create(runtimeId: "runtime-other"), Fixture.Create(appUnpackedSize: Payload.Length + 1), Fixture.Create(appEntrypoint: "other.exe"), Fixture.Create(createdAt: "2025-01-02T00:00:00Z")
        };
        var paths = new List<string>();
        foreach (var fixture in fixtures) { await using var lease = await downloader.DownloadAsync(fixture.AppRequest); paths.Add(lease.Path); }
        Need(paths.Distinct(StringComparer.OrdinalIgnoreCase).Count() == paths.Count, "different signed artifact identities shared a cache path");

        var keyA = Fixture.Create(seed: SeedA); var keyB = Fixture.Create(seed: SeedB);
        await using var keyLeaseA = await downloader.DownloadAsync(keyA.AppRequest); await using var keyLeaseB = await downloader.DownloadAsync(keyB.AppRequest);
        Need(keyLeaseA.Path != keyLeaseB.Path && keyLeaseA.Identity.VerifierIdentity != keyLeaseB.Identity.VerifierIdentity, "different Ed25519 keysets shared cache identity");

        var compact = Fixture.Create(indented: false); var indented = Fixture.Create(indented: true);
        await using var compactLease = await downloader.DownloadAsync(compact.AppRequest); await using var indentedLease = await downloader.DownloadAsync(indented.AppRequest);
        Need(compact.Proof.SigningPayloadSha256 == indented.Proof.SigningPayloadSha256 && compact.Proof.RawManifestSha256 != indented.Proof.RawManifestSha256 && compactLease.Path != indentedLease.Path, "raw manifest digest isolation failed");
        var later = Fixture.Create(generatedAt: "2025-01-03T00:00:00Z"); await using var laterLease = await downloader.DownloadAsync(later.AppRequest);
        Need(laterLease.Path != compactLease.Path, "re-signed generatedAt did not isolate cache");

        using var parallelScope = new Scope(); var entered = 0; var both = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var parallelTransport = new FakeTransport(async (request, token) => { if (Interlocked.Increment(ref entered) == 2) both.TrySetResult(null); await both.Task.WaitAsync(token); return Response(Payload, requestUri: request.RequestUri); }); using var parallel = parallelScope.Downloader(parallelTransport);
        var concurrent = await Task.WhenAll(parallel.DownloadAsync(fixtures[0].AppRequest), parallel.DownloadAsync(fixtures[1].AppRequest)); Need(concurrent[0].Path != concurrent[1].Path && parallelTransport.MaxActive >= 2, "different identities did not run independently"); foreach (var lease in concurrent) await lease.DisposeAsync();
    }

    private static async Task RuntimeIdentityAsync()
    {
        var fixture = Fixture.Create(); using var scope = new Scope(); using var downloader = scope.Downloader(new FakeTransport(request => Response(RuntimePayload, requestUri: request.RequestUri)));
        await using var lease = await downloader.DownloadAsync(fixture.RuntimeRequest); var runtime = fixture.Selection.Runtime; var identity = lease.Identity;
        Need(lease.Kind == runtime.Kind && identity.RuntimeId == runtime.RuntimeId && identity.Url == runtime.Url && identity.Sha256 == runtime.Sha256 && identity.Version is null && identity.BuildId is null && identity.CommitSha is null, "runtime proof identity");
    }

    private static async Task LeaseAsync()
    {
        var fixture = Fixture.Create(); using var scope = new Scope(); using var downloader = scope.Downloader(new FakeTransport(request => Response(Payload, requestUri: request.RequestUri))); string path;
        var lease = await downloader.DownloadAsync(fixture.AppRequest); path = lease.Path; var changed = false; var moved = path + ".moved";
        try { File.Move(path, moved); changed = true; } catch (IOException) { }
        if (!changed) try { File.Delete(path); changed = true; } catch (IOException) { }
        lease.Stream.Position = 0; Need((await ReadAllAsync(lease.Stream)).SequenceEqual(Payload), "leased handle changed with path"); lease.Dispose(); await lease.DisposeAsync(); NeedThrows<ObjectDisposedException>(() => _ = lease.Stream);
        if (File.Exists(path)) { File.Move(path, moved); changed = true; } Need(changed && File.Exists(moved), "file not manageable after dispose"); File.Delete(moved);
    }

    private static async Task TamperAsync()
    {
        var fixture = Fixture.Create(); using var scope = new Scope(); var transport = new FakeTransport(request => Response(Payload, requestUri: request.RequestUri)); using var downloader = scope.Downloader(transport); string path;
        await using (var lease = await downloader.DownloadAsync(fixture.AppRequest)) path = lease.Path;
        File.WriteAllBytes(path, new byte[Payload.Length]); await using var replaced = await downloader.DownloadAsync(fixture.AppRequest); Need(!replaced.CacheHit && transport.Calls == 2 && Directory.GetFiles(scope.Downloads, "*.corrupt-*").Length > 0, "quarantine/redownload");
    }

    private static async Task ValidationAsync()
    {
        await RejectAsync(_ => Response(Payload, Payload.Length + 1), Fixture.Create().AppRequest, typeof(ArtifactDownloaderException));
        await RejectAsync(_ => Response(Payload[..^1], null), Fixture.Create().AppRequest, typeof(ArtifactDownloaderException));
        await RejectAsync(_ => Response(Payload.Concat(new byte[] { 1 }).ToArray(), null), Fixture.Create().AppRequest, typeof(ArtifactDownloaderException));
        await RejectAsync(_ => Response(Payload), Fixture.Create(appPayload: Encoding.UTF8.GetBytes("expected other bytes")).AppRequest, typeof(ArtifactDownloaderException));
        await RejectAsync(_ => Response(Payload, requestUri: new Uri(ReleaseUrl("other.zip"))), Fixture.Create().AppRequest, typeof(ArtifactDownloaderException));
        await RejectAsync(_ => Response(Payload, status: HttpStatusCode.Redirect), Fixture.Create().AppRequest, typeof(ArtifactDownloaderException));
        using var scope = new Scope(); using var downloader = scope.Downloader(new FakeTransport(request => Response(Payload, requestUri: request.RequestUri)), [new TrustedReleaseSource("https://example.com", "/owner/repo")]);
        await ThrowsAsync<ArtifactDownloaderException>(async () => { await using var lease = await downloader.DownloadAsync(Fixture.Create().AppRequest); });
    }

    private static async Task TransportAsync()
    {
        await RejectAsync(_ => Response(new ThrowingStream(new IOException("body")), Payload.Length), Fixture.Create().AppRequest, typeof(ArtifactTransportException));
        await RejectAsync(_ => Response(new ThrowingStream(new OperationCanceledException("timeout")), Payload.Length), Fixture.Create().AppRequest, typeof(ArtifactTransportException));
        var fixture = Fixture.Create(); using var scope = new Scope(); using var cancellation = new CancellationTokenSource(); var transport = new FakeTransport(async (_, token) => { cancellation.Cancel(); await Task.Delay(Timeout.InfiniteTimeSpan, token); return Response(Payload); }); using var downloader = scope.Downloader(transport);
        await ThrowsAsync<OperationCanceledException>(async () => { await using var lease = await downloader.DownloadAsync(fixture.AppRequest, cancellation.Token); }); Need(Directory.GetFiles(scope.Downloads, "*.partial").Length == 0, "partial cleanup");
    }

    private static async Task ConcurrencyAsync()
    {
        var fixture = Fixture.Create(); using var scope = new Scope(); var gate = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously); var transport = new FakeTransport(async (request, token) => { await gate.Task.WaitAsync(token); return Response(Payload, requestUri: request.RequestUri); }); using var downloader = scope.Downloader(transport);
        var one = downloader.DownloadAsync(fixture.AppRequest); var two = downloader.DownloadAsync(fixture.AppRequest); await Task.Delay(100); gate.SetResult(null); await using (var first = await one) Need((await ReadAllAsync(first.Stream)).SequenceEqual(Payload), "first concurrent bytes"); await using (var second = await two) Need(second.CacheHit, "second concurrent cache hit"); Need(transport.Calls == 1, "same capability used network twice");
        var bytes = Encoding.UTF8.GetBytes("different"); var differentFixture = Fixture.Create(appPayload: bytes, appUrl: ReleaseUrl("b.zip")); using var secondScope = new Scope(); var entered = 0; var both = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously); var parallelTransport = new FakeTransport(async (request, token) => { if (Interlocked.Increment(ref entered) == 2) both.TrySetResult(null); await both.Task.WaitAsync(token); return Response(request.RequestUri!.AbsolutePath.EndsWith("b.zip", StringComparison.Ordinal) ? bytes : Payload, requestUri: request.RequestUri); }); using var parallel = secondScope.Downloader(parallelTransport);
        var leases = await Task.WhenAll(parallel.DownloadAsync(fixture.AppRequest), parallel.DownloadAsync(differentFixture.AppRequest)); foreach (var lease in leases) await lease.DisposeAsync(); Need(parallelTransport.MaxActive >= 2, "different proof requests did not run in parallel");
    }

    private static async Task MetadataAsync()
    {
        var first = Fixture.Create(); var second = Fixture.Create(appUrl: ReleaseUrl("b.zip")); using var scope = new Scope(); var transport = new FakeTransport(request => Response(Payload, requestUri: request.RequestUri)); using var downloader = scope.Downloader(transport); string firstPath; string secondPath;
        await using (var lease = await downloader.DownloadAsync(first.AppRequest)) firstPath = lease.Path;
        File.WriteAllText(firstPath + ".metadata.json", "{broken"); await using (var hit = await downloader.DownloadAsync(first.AppRequest)) Need(hit.CacheHit && transport.Calls == 1 && Directory.GetFiles(scope.Downloads, "*.corrupt-*.json").Length > 0, "metadata recovery");
        await using (var lease = await downloader.DownloadAsync(second.AppRequest)) secondPath = lease.Path;
        var original = File.ReadAllText(firstPath + ".metadata.json"); File.Copy(secondPath + ".metadata.json", firstPath + ".metadata.json", true); await ThrowsAsync<ArtifactDownloaderException>(async () => { await using var lease = await downloader.DownloadAsync(first.AppRequest); }); Need(File.ReadAllText(firstPath + ".metadata.json") != original && File.Exists(firstPath), "identity conflict was overwritten");
    }

    private static async Task LinkAsync()
    {
        if (!OperatingSystem.IsWindows()) throw new SkipException("Windows only"); var fixture = Fixture.Create(); using var scope = new Scope(); var outside = Path.Combine(scope.Root, "outside.bin"); File.WriteAllBytes(outside, Payload); Directory.CreateDirectory(scope.Downloads); using var downloader = scope.Downloader(new FakeTransport(request => Response(Payload, requestUri: request.RequestUri))); string final;
        await using (var seed = await downloader.DownloadAsync(fixture.AppRequest)) final = seed.Path; File.Delete(final); File.Delete(final + ".metadata.json");
        if (!CreateHardLinkW(final, outside, IntPtr.Zero)) throw new SkipException("hardlink fixture unavailable"); await ThrowsAsync<ArtifactDownloaderException>(async () => { await using var lease = await downloader.DownloadAsync(fixture.AppRequest); }); Need(File.ReadAllBytes(outside).SequenceEqual(Payload), "outside changed"); File.Delete(final);
        try { File.CreateSymbolicLink(final, outside); } catch (Exception exception) { throw new SkipException("symlink fixture: " + exception.Message); } await ThrowsAsync<ArtifactDownloaderException>(async () => { await using var lease = await downloader.DownloadAsync(fixture.AppRequest); });
    }

    private static async Task RejectAsync(Func<HttpRequestMessage, HttpResponseMessage> handler, VerifiedArtifactRequest request, Type expected)
    {
        using var scope = new Scope(); using var downloader = scope.Downloader(new FakeTransport(handler)); try { await using var lease = await downloader.DownloadAsync(request); throw new Exception("expected rejection"); } catch (Exception exception) when (expected.IsInstanceOfType(exception)) { } Need(Directory.GetFiles(scope.Downloads, "*.partial").Length == 0, "partial remained");
    }

    private static string ReleaseUrl(string file) => "https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/download/selftest/" + file;
    private static async Task<byte[]> ReadAllAsync(Stream stream) { using var memory = new MemoryStream(); await stream.CopyToAsync(memory); return memory.ToArray(); }
    private static HttpResponseMessage Response(byte[] bytes, long? length = null, Uri? requestUri = null, HttpStatusCode status = HttpStatusCode.OK) => Response(new MemoryStream(bytes, false), length ?? bytes.Length, requestUri, status);
    private static HttpResponseMessage Response(Stream stream, long? length, Uri? requestUri = null, HttpStatusCode status = HttpStatusCode.OK) { var response = new HttpResponseMessage(status) { Content = new StreamContent(stream), RequestMessage = new HttpRequestMessage(HttpMethod.Get, requestUri ?? new Uri(ReleaseUrl("app.zip"))) }; response.Content.Headers.ContentLength = length; return response; }
    private static async Task ThrowsAsync<T>(Func<Task> action) where T : Exception { try { await action(); } catch (T) { return; } throw new Exception("Expected " + typeof(T).Name); }
    private static void NeedThrows<T>(Action action) where T : Exception { try { action(); } catch (T) { return; } throw new Exception("Expected " + typeof(T).Name); }
    private static void Need(bool value, string message) { if (!value) throw new Exception(message); }

    private sealed class Fixture
    {
        private Fixture(VerifiedChannelManifestProof proof, SelectedArtifactsV1 selection) { Proof = proof; Selection = selection; (AppRequest, RuntimeRequest) = proof.CreateRequests(selection); }
        public VerifiedChannelManifestProof Proof { get; }
        public SelectedArtifactsV1 Selection { get; }
        public VerifiedArtifactRequest AppRequest { get; }
        public VerifiedArtifactRequest RuntimeRequest { get; }

        public static Fixture Create(byte[]? appPayload = null, byte[]? runtimePayload = null, string? appUrl = null, string? runtimeUrl = null, string buildTime = "20250101-000000", string? commitSha = null, string runtimeId = "runtime-1", long? appUnpackedSize = null, string appEntrypoint = "app.exe", string runtimeEntrypoint = "node.exe", string createdAt = "2025-01-01T00:00:00Z", string generatedAt = "2025-01-02T00:00:00Z", byte[]? seed = null, bool indented = false)
        {
            appPayload ??= Payload; runtimePayload ??= RuntimePayload; appUrl ??= ReleaseUrl("app.zip"); runtimeUrl ??= ReleaseUrl("runtime.zip"); commitSha ??= new string('0', 40); seed ??= SeedA;
            var buildId = buildTime + "-" + commitSha[..7]; const string keyId = "selftest-key";
            var unsigned = new Dictionary<string, object?>
            {
                ["schema"] = 1, ["channel"] = "stable", ["generatedAt"] = generatedAt,
                ["releases"] = new object[] { new Dictionary<string, object?>
                {
                    ["version"] = "1.0.0", ["buildId"] = buildId, ["commitSha"] = commitSha, ["publishedAt"] = createdAt,
                    ["releaseNotesUrl"] = ReleaseUrl("notes"), ["minimumLauncherVersion"] = "1.0.0",
                    ["artifacts"] = new Dictionary<string, object?>
                    {
                        ["app"] = Artifact("app", appUrl, appPayload, appUnpackedSize ?? appPayload.Length, appEntrypoint, createdAt, runtimeId, buildId, commitSha),
                        ["runtime"] = Artifact("runtime", runtimeUrl, runtimePayload, runtimePayload.Length, runtimeEntrypoint, createdAt, runtimeId, null, null)
                    }
                }}
            };
            var placeholder = new Dictionary<string, object?>(unsigned) { ["signature"] = new Dictionary<string, object?> { ["algorithm"] = "ed25519", ["keyId"] = keyId, ["value"] = Convert.ToBase64String(new byte[64]) } };
            var placeholderRaw = JsonSerializer.Serialize(placeholder); var parsed = OfflineUpdateDecision.ParseChannelManifest(placeholderRaw, "stable"); var signingPayload = OfflineUpdateDecision.SigningPayload(parsed);
            var privateKey = new Ed25519PrivateKeyParameters(seed, 0); var signer = new Ed25519Signer(); signer.Init(true, privateKey); signer.BlockUpdate(signingPayload, 0, signingPayload.Length); var signature = signer.GenerateSignature();
            var signed = new Dictionary<string, object?>(unsigned) { ["signature"] = new Dictionary<string, object?> { ["algorithm"] = "ed25519", ["keyId"] = keyId, ["value"] = Convert.ToBase64String(signature) } };
            var raw = JsonSerializer.Serialize(signed, new JsonSerializerOptions { WriteIndented = indented }); var verifier = new Ed25519ChannelManifestSignatureVerifier(new Dictionary<string, byte[]> { [keyId] = privateKey.GeneratePublicKey().GetEncoded() });
            var proof = OfflineUpdateDecision.ParseAndVerifyChannelManifest(raw, "stable", verifier); var selection = proof.SelectLatestArtifacts() ?? throw new Exception("fixture selection failed"); return new Fixture(proof, selection);
        }

        private static Dictionary<string, object?> Artifact(string kind, string url, byte[] payload, long unpackedSize, string entrypoint, string createdAt, string runtimeId, string? buildId, string? commitSha)
        {
            var artifact = new Dictionary<string, object?> { ["kind"] = kind, ["runtimeId"] = runtimeId, ["platform"] = "win32", ["arch"] = "x64", ["url"] = url, ["sha256"] = Convert.ToHexString(SHA256.HashData(payload)).ToLowerInvariant(), ["size"] = payload.Length, ["unpackedSize"] = unpackedSize, ["entrypoint"] = entrypoint, ["createdAt"] = createdAt };
            if (kind == "app") { artifact["version"] = "1.0.0"; artifact["buildId"] = buildId; artifact["commitSha"] = commitSha; }
            return artifact;
        }
    }

    private sealed class Scope : IDisposable
    {
        public Scope() { Root = Path.Combine(Path.GetTempPath(), "MagicPot-artifact-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(Root); Downloads = Path.Combine(Root, "downloads"); }
        public string Root { get; } public string Downloads { get; }
        public ArtifactDownloader Downloader(FakeTransport transport, IReadOnlyList<TrustedReleaseSource>? trustedSources = null) => new(new ArtifactDownloadOptions { StateRoot = Root, TrustedSources = trustedSources, Timeout = TimeSpan.FromMilliseconds(300), LockTimeout = TimeSpan.FromSeconds(5), UniqueId = () => Interlocked.Increment(ref unique).ToString("x") }, transport);
        public void Dispose() { try { Directory.Delete(Root, true); } catch (Exception) { } }
    }

    private sealed class FakeTransport : IChannelManifestTransport
    {
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler; private int calls; private int active; private int max;
        public FakeTransport(Func<HttpRequestMessage, HttpResponseMessage> handler) : this((request, _) => Task.FromResult(handler(request))) { }
        public FakeTransport(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler) => this.handler = handler;
        public int Calls => calls; public int MaxActive => max;
        public async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) { Interlocked.Increment(ref calls); var current = Interlocked.Increment(ref active); while (current > max) Interlocked.CompareExchange(ref max, current, max); try { return await handler(request, token); } finally { Interlocked.Decrement(ref active); } }
        public void Dispose() { }
    }

    private sealed class ThrowingStream(Exception exception) : Stream
    {
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false; public override long Length => throw new NotSupportedException(); public override long Position { get => 0; set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw exception; public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => ValueTask.FromException<int>(exception); public override void Flush() { } public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateHardLinkW(string fileName, string existingFileName, IntPtr securityAttributes);
    private sealed class SkipException(string message) : Exception(message);
}
