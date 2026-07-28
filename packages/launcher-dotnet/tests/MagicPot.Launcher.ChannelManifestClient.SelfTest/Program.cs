using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using MagicPot.Launcher;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.Security;

internal static class Program
{
    private static readonly Ed25519PrivateKeyParameters PrivateKey = new(new SecureRandom());
    private static readonly byte[] PublicKey = PrivateKey.GeneratePublicKey().GetEncoded();
    private static readonly IChannelManifestSignatureVerifier Verifier = new Ed25519ChannelManifestSignatureVerifier(new Dictionary<string, byte[]> { ["test-key"] = PublicKey });

    private static readonly IChannelManifestSignatureVerifier OtherVerifier = new Ed25519ChannelManifestSignatureVerifier(new Dictionary<string, byte[]> { ["other-key"] = PublicKey });
    private static int assertions;

    public static async Task Main()
    {
        await Run("200 save, validators, 304", SaveAndNotModified);
        await Run("network fallback and HTTP 500 no fallback", FallbackRules);
        await Run("bad signature and cache reverify", SignatureRules);
        await Run("oversize length/stream and invalid UTF-8", BodyRules);
        await Run("rollback and equivocation", HighWaterRules);
        await Run("identity mismatch and 304 without cache", IdentityAnd304Rules);
        await Run("high-water/cache crash recovery and redirect", RecoveryAndRedirect);
        await Run("final response URI validation", FinalResponseUriRules);
        await Run("response body interruption fallback", InterruptedBodyRules);
        await Run("response body timeout and caller cancellation", BodyCancellationRules);
        await Run("corrupt cache quarantine and recovery", CorruptCacheRecoveryRules);
        await Run("cross-client state transaction serialization", ConcurrentStateRules);
        await Run("named mutex await, reacquire, concurrency, and cancellation", NamedMutexRules);
        await Run("transport API and fixed state root", TransportAndStateRootRules);
        await Run("persistence path validation", PersistencePathRules);
        await Run("root identity and hardlink defenses", RootIdentityAndHardLinkRules);
        await Run("state lock reparse and hardlink defenses", StateLockLinkRules);
        Console.WriteLine("PASS: " + assertions + " assertions");
    }

    private static async Task SaveAndNotModified(string directory)
    {
        var manifest = Manifest("2025-01-01T00:00:00.000Z");
        var handler = new QueueTransport(_ => Response(HttpStatusCode.OK, manifest, "\"v1\"", "Wed, 01 Jan 2025 00:00:00 GMT"), request =>
        {
            Equal("application/json", request.Headers.Accept.ToString()); Equal("\"v1\"", request.Headers.IfNoneMatch.ToString());
            True(request.Headers.IfModifiedSince.HasValue, "If-Modified-Since missing"); return new HttpResponseMessage(HttpStatusCode.NotModified);
        });
        using var client = Client(directory, handler);
        Equal("network", (await client.LoadAsync()).Source); True(File.Exists(Path.Combine(directory, "cache.json")), "cache not saved");
        True(File.Exists(Path.Combine(directory, "high-water.json")), "high-water not saved"); Equal("not-modified-cache", (await client.LoadAsync()).Source);
    }

    private static async Task FallbackRules(string directory)
    {
        var handler = new QueueTransport(_ => Response(HttpStatusCode.OK, Manifest("2025-01-01T00:00:00Z")), _ => throw new HttpRequestException("offline"), _ => new HttpResponseMessage(HttpStatusCode.InternalServerError));
        using var client = Client(directory, handler); await client.LoadAsync(); Equal("network-error-cache", (await client.LoadAsync()).Source);
        await Throws(() => client.LoadAsync(), "HTTP 500 must not fall back");
        using var unavailable = Client(directory + "-unavailable", new QueueTransport(_ => throw new HttpRequestException("offline")));
        await ThrowsKind(() => unavailable.LoadAsync(), ChannelManifestFailureKind.Unavailable, "transport without cache");
    }

    private static async Task SignatureRules(string directory)
    {
        var good = Manifest("2025-01-01T00:00:00Z");
        var bad = CorruptSignature(good);
        True(!string.Equals(good, bad, StringComparison.Ordinal), "corrupted signature fixture must change the manifest");
        try
        {
            OfflineUpdateDecision.ParseAndVerifyChannelManifest(bad, "stable", Verifier);
            throw new Exception("Expected direct signature verification rejection.");
        }
        catch (OfflineUpdateException)
        {
            assertions++;
        }
        using var client = Client(directory, new QueueTransport(_ => Response(HttpStatusCode.OK, good), _ => Response(HttpStatusCode.OK, bad)));
        await client.LoadAsync(); await ThrowsKind(() => client.LoadAsync(), ChannelManifestFailureKind.Failed, "bad network signature must not fall back");
        CorruptCachedManifest(Path.Combine(directory, "cache.json"));
        using var offline = Client(directory, new QueueTransport(_ => throw new HttpRequestException("offline")));
        await Throws(() => offline.LoadAsync(), "cache must be reverified on every load");
    }

    private static async Task BodyRules(string directory)
    {
        var largeLength = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent([1]) }; largeLength.Content.Headers.ContentLength = 99;
        using (var client = Client(directory, new QueueTransport(_ => largeLength), 32)) await Throws(() => client.LoadAsync(), "Content-Length limit");
        using (var client = Client(directory + "-stream", new QueueTransport(_ => Response(HttpStatusCode.OK, new string('x', 64))), 32)) await Throws(() => client.LoadAsync(), "stream limit");
        var invalid = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent([0xc3, 0x28]) };
        using (var client = Client(directory + "-utf8", new QueueTransport(_ => invalid))) await Throws(() => client.LoadAsync(), "strict UTF-8");
    }

    private static async Task HighWaterRules(string directory)
    {
        var current = Manifest("2025-02-01T00:00:00Z"); var old = Manifest("2025-01-01T00:00:00Z"); var differentRaw = current.Insert(1, " ");
        using var client = Client(directory, new QueueTransport(_ => Response(HttpStatusCode.OK, current), _ => Response(HttpStatusCode.OK, old), _ => Response(HttpStatusCode.OK, differentRaw)));
        await client.LoadAsync(); await Throws(() => client.LoadAsync(), "rollback rejected"); await Throws(() => client.LoadAsync(), "equivocation rejected");
    }

    private static async Task IdentityAnd304Rules(string directory)
    {
        using (var first = Client(directory, new QueueTransport(_ => Response(HttpStatusCode.OK, Manifest("2025-01-01T00:00:00Z"))))) await first.LoadAsync();
        File.Delete(Path.Combine(directory, "high-water.json"));
        using (var changed = Client(directory, new QueueTransport(_ => throw new HttpRequestException("offline")), verifier: OtherVerifier)) await Throws(() => changed.LoadAsync(), "identity mismatch cache ignored");
        using (var noCache = Client(directory + "-304", new QueueTransport(_ => new HttpResponseMessage(HttpStatusCode.NotModified)))) await Throws(() => noCache.LoadAsync(), "304 without cache");
    }

    private static async Task RecoveryAndRedirect(string directory)
    {
        var old = Manifest("2025-01-01T00:00:00Z"); var next = Manifest("2025-02-01T00:00:00Z");
        using (var seed = Client(directory, new QueueTransport(_ => Response(HttpStatusCode.OK, old)))) await seed.LoadAsync();
        var oldCache = File.ReadAllText(Path.Combine(directory, "cache.json"));
        using (var advance = Client(directory, new QueueTransport(_ => Response(HttpStatusCode.OK, next)))) await advance.LoadAsync();
        File.WriteAllText(Path.Combine(directory, "cache.json"), oldCache);
        using (var recover = Client(directory, new QueueTransport(_ => Response(HttpStatusCode.OK, next)))) Equal("network", (await recover.LoadAsync()).Source);
        using var redirect = Client(directory + "-redirect", new QueueTransport(_ => new HttpResponseMessage(HttpStatusCode.Redirect) { Headers = { Location = new Uri("https://example.test/elsewhere") } }));
        await Throws(() => redirect.LoadAsync(), "redirect rejected");
    }

    private static async Task FinalResponseUriRules(string directory)
    {
        var response = Response(HttpStatusCode.OK, Manifest("2025-01-01T00:00:00Z"));
        response.RequestMessage = new HttpRequestMessage(HttpMethod.Get, "https://evil.test/channel.json");
        using (var client = Client(directory, new QueueTransport(_ => response)))
            await Throws(() => client.LoadAsync(), "auto-redirected final URI rejected");
        using var missing = new ChannelManifestClient(Options(Path.Combine(directory, "missing")), new MissingUriTransport(Response(HttpStatusCode.OK, Manifest("2025-01-01T00:00:00Z"))), true);
        await Throws(() => missing.LoadAsync(), "missing final response URI rejected");
    }

    private static async Task InterruptedBodyRules(string directory)
    {
        using (var seed = Client(directory, new QueueTransport(_ => Response(HttpStatusCode.OK, Manifest("2025-01-01T00:00:00Z"))))) await seed.LoadAsync();
        using (var cached = Client(directory, new QueueTransport(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new ThrowingReadStream()) })))
            Equal("network-error-cache", (await cached.LoadAsync()).Source);
        using (var empty = Client(directory + "-empty", new QueueTransport(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new ThrowingReadStream()) })))
            await Throws(() => empty.LoadAsync(), "interrupted body without cache rejected");
    }

    private static async Task BodyCancellationRules(string directory)
    {
        using (var seed = Client(directory, new QueueTransport(_ => Response(HttpStatusCode.OK, Manifest("2025-01-01T00:00:00Z"))))) await seed.LoadAsync();
        using (var cached = Client(directory, new QueueTransport(_ => BlockingResponse()), timeout: TimeSpan.FromMilliseconds(100)))
            Equal("network-error-cache", (await cached.LoadAsync()).Source);
        using (var empty = Client(directory + "-empty", new QueueTransport(_ => BlockingResponse()), timeout: TimeSpan.FromMilliseconds(100)))
            await Throws(() => empty.LoadAsync(), "body timeout without cache rejected");
        using var canceled = Client(directory, new QueueTransport(_ => BlockingResponse()), timeout: TimeSpan.FromSeconds(5));
        using var cancellation = new CancellationTokenSource(100);
        await ThrowsCanceled(() => canceled.LoadAsync(cancellation.Token), "caller body cancellation must not fall back");
    }

    private static async Task CorruptCacheRecoveryRules(string directory)
    {
        var old = Manifest("2025-01-01T00:00:00Z");
        var next = Manifest("2025-02-01T00:00:00Z");
        using (var seed = Client(directory, new QueueTransport(_ => Response(HttpStatusCode.OK, old)))) await seed.LoadAsync();
        var cachePath = Path.Combine(directory, "cache.json");

        File.WriteAllText(cachePath, "{\"schema\":1");
        using (var truncated = Client(directory, new QueueTransport(_ => Response(HttpStatusCode.OK, next)))) Equal("network", (await truncated.LoadAsync()).Source);
        True(Quarantines(directory).Length == 1, "truncated cache was not quarantined");

        AddCacheField(cachePath, "unknown", true);
        using (var unknown = Client(directory, new QueueTransport(_ => Response(HttpStatusCode.OK, next)))) Equal("network", (await unknown.LoadAsync()).Source);
        True(Quarantines(directory).Length == 2, "unknown-field cache was not quarantined");

        CorruptCachedManifest(cachePath);
        using (var signature = Client(directory, new QueueTransport(_ => Response(HttpStatusCode.OK, next)))) Equal("network", (await signature.LoadAsync()).Source);
        True(Quarantines(directory).Length == 3, "bad-signature cache was not quarantined");

        SetCacheField(cachePath, "configIdentity", "different-configuration");
        using (var mismatch = Client(directory, new QueueTransport(_ => new HttpResponseMessage(HttpStatusCode.NotModified))))
            await Throws(() => mismatch.LoadAsync(), "identity mismatch is ignored without quarantine");
        True(Quarantines(directory).Length == 3, "identity mismatch must not quarantine cache");

        using (var oldRoot = Client(directory + "-stale", new QueueTransport(_ => Response(HttpStatusCode.OK, old)))) await oldRoot.LoadAsync();
        var stalePath = Path.Combine(directory + "-stale", "cache.json");
        var staleText = File.ReadAllText(stalePath);
        using (var advance = Client(directory + "-stale", new QueueTransport(_ => Response(HttpStatusCode.OK, next)))) await advance.LoadAsync();
        File.WriteAllText(stalePath, staleText);
        using (var staleOffline = Client(directory + "-stale", new QueueTransport(_ => throw new HttpRequestException("offline"))))
            await Throws(() => staleOffline.LoadAsync(), "stale cache must not be used on network failure");
        True(Quarantines(directory + "-stale").Length == 1, "stale cache was not quarantined");
        using (var recover = Client(directory + "-stale", new QueueTransport(_ => Response(HttpStatusCode.OK, next)))) Equal("network", (await recover.LoadAsync()).Source);

        var failRoot = directory + "-rename-fail";
        using (var seedFail = Client(failRoot, new QueueTransport(_ => Response(HttpStatusCode.OK, old)))) await seedFail.LoadAsync();
        File.WriteAllText(Path.Combine(failRoot, "cache.json"), "{");
        File.WriteAllText(Path.Combine(failRoot, "cache.corrupt-blocked.json"), "occupied");
        var failOptions = Options(failRoot, uniqueId: () => "blocked");
        var transportCalled = false;
        using var fail = new ChannelManifestClient(failOptions, new QueueTransport(_ => { transportCalled = true; return Response(HttpStatusCode.OK, next); }), true);
        await Throws(() => fail.LoadAsync(), "quarantine rename failure must fail closed");
        True(!transportCalled, "network used after quarantine failure");
    }

    private static async Task ConcurrentStateRules(string directory)
    {
        var newerEntered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseNewer = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var newer = Client(directory, new AsyncTransport(async request =>
        {
            newerEntered.SetResult(true);
            await releaseNewer.Task.ConfigureAwait(false);
            return Response(HttpStatusCode.OK, Manifest("2025-02-01T00:00:00Z"));
        }));
        using var older = Client(directory, new QueueTransport(_ => Response(HttpStatusCode.OK, Manifest("2025-01-01T00:00:00Z"))));
        var newerTask = newer.LoadAsync();
        await newerEntered.Task.ConfigureAwait(false);
        var olderTask = older.LoadAsync();
        await Task.Delay(100).ConfigureAwait(false);
        releaseNewer.SetResult(true);
        Equal("network", (await newerTask.ConfigureAwait(false)).Source);
        await Throws(() => olderTask, "serialized older response cannot roll state back");
        using var verify = Client(directory, new QueueTransport(_ => throw new HttpRequestException("offline")));
        var final = await verify.LoadAsync().ConfigureAwait(false);
        Equal("2025-02-01T00:00:00Z", final.VerifiedManifest.Manifest.GeneratedAt);
        True(File.Exists(Path.Combine(directory, "update.lock")), "persistent state lock file missing");
    }

    private static async Task NamedMutexRules(string directory)
    {
        var firstEntered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirst = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var first = Client(directory, new AsyncTransport(async _ =>
        {
            firstEntered.TrySetResult(true);
            await Task.Yield();
            await releaseFirst.Task.ConfigureAwait(false);
            return Response(HttpStatusCode.OK, Manifest("2025-03-01T00:00:00Z"));
        }));
        using var second = Client(directory, new QueueTransport(
            _ => new HttpResponseMessage(HttpStatusCode.NotModified),
            _ => new HttpResponseMessage(HttpStatusCode.NotModified)));

        var firstTask = first.LoadAsync();
        await firstEntered.Task.ConfigureAwait(false);
        var secondTask = second.LoadAsync();
        await Task.Delay(100).ConfigureAwait(false);
        True(!secondTask.IsCompleted, "second client bypassed named mutex");

        var canceledOptions = Options(directory);
        canceledOptions = new ChannelManifestClientOptions
        {
            Url = canceledOptions.Url, Channel = canceledOptions.Channel, StateRoot = canceledOptions.StateRoot,
            SignatureVerifier = canceledOptions.SignatureVerifier,
            MaxResponseBytes = canceledOptions.MaxResponseBytes, UniqueId = canceledOptions.UniqueId,
            StateLockTimeout = TimeSpan.FromSeconds(2), StateLockRetryDelay = TimeSpan.FromMilliseconds(10)
        };
        using var canceledClient = new ChannelManifestClient(canceledOptions, new QueueTransport(_ => throw new Exception("canceled waiter reached transport")), true);
        using var cancellation = new CancellationTokenSource(100);
        await ThrowsCanceled(() => canceledClient.LoadAsync(cancellation.Token), "named mutex wait cancellation");

        releaseFirst.TrySetResult(true);
        Equal("network", (await firstTask.ConfigureAwait(false)).Source);
        Equal("not-modified-cache", (await secondTask.ConfigureAwait(false)).Source);
        Equal("not-modified-cache", (await second.LoadAsync().ConfigureAwait(false)).Source);
    }

    private static Task TransportAndStateRootRules(string directory)
    {
        True(typeof(ChannelManifestClientOptions).GetProperty("HttpClient", BindingFlags.Public | BindingFlags.Instance) is null, "HttpClient must not be injectable through public options");
        True(typeof(IChannelManifestTransport).GetMethod("SendAsync") is not null, "transport API missing");
        using var production = new ChannelManifestClient(Options(directory));
        var field = typeof(ChannelManifestClient).GetField("transport", BindingFlags.NonPublic | BindingFlags.Instance);
        True(field?.GetValue(production) is DefaultChannelManifestTransport, "production transport type is not controlled");
        Equal("cache.json", Path.GetFileName(Path.Combine(directory, "cache.json")));
        Equal("high-water.json", Path.GetFileName(Path.Combine(directory, "high-water.json")));
        Equal("update.lock", Path.GetFileName(Path.Combine(directory, "update.lock")));
        return Task.CompletedTask;
    }

    private static Task PersistencePathRules(string directory)
    {
        ThrowsArgument(() => new ChannelManifestClient(new ChannelManifestClientOptions
        {
            Url = "https://example.test/channel.json", Channel = "stable", StateRoot = "relative",
            SignatureVerifier = Verifier
        }), "relative StateRoot");
        if (OperatingSystem.IsWindows())
        {
            Directory.CreateDirectory(directory);
            var target = Path.Combine(directory, "target");
            var link = Path.Combine(directory, "junction");
            Directory.CreateDirectory(target);
            try
            {
                Directory.CreateSymbolicLink(link, target);
                ThrowsClient(() => new ChannelManifestClient(Options(link)), "reparse state root");
            }
            catch (UnauthorizedAccessException) { Console.WriteLine("SKIP reparse test: no privilege"); }
            catch (IOException) { Console.WriteLine("SKIP reparse test: link creation failed"); }
            catch (PlatformNotSupportedException) { Console.WriteLine("SKIP reparse test: unsupported"); }
        }
        return Task.CompletedTask;
    }

    private static async Task RootIdentityAndHardLinkRules(string directory)
    {
        if (!OperatingSystem.IsWindows()) return;
        Directory.CreateDirectory(directory);
        using (var client = Client(directory, new QueueTransport(_ => throw new HttpRequestException("unused"))))
        {
            var moved = directory + "-moved";
            Directory.Move(directory, moved);
            Directory.CreateDirectory(directory);
            try { await Throws(() => client.LoadAsync(), "replaced StateRoot identity"); }
            finally { try { Directory.Delete(directory, true); } catch (Exception) { } Directory.Move(moved, directory); }
        }

        var hardRoot = directory + "-hard";
        Directory.CreateDirectory(hardRoot);
        File.WriteAllText(Path.Combine(hardRoot, "cache.json"), "{}");
        if (!CreateHardLink(Path.Combine(hardRoot, "high-water.json"), Path.Combine(hardRoot, "cache.json"), IntPtr.Zero))
        {
            Console.WriteLine("SKIP hardlink test: Win32 error " + Marshal.GetLastWin32Error());
            return;
        }
        try
        {
            using var hardClient = Client(hardRoot, new QueueTransport(_ => throw new HttpRequestException("unused")));
            await Throws(() => hardClient.LoadAsync(), "hardlink alias/multiple links");
        }
        catch (ChannelManifestClientException) { assertions++; }
    }

    private static async Task StateLockLinkRules(string directory)
    {
        if (!OperatingSystem.IsWindows()) return;

        var hardRoot = directory + "-lock-hard";
        var hardOutside = directory + "-outside-hard.lock";
        Directory.CreateDirectory(hardRoot);
        File.WriteAllText(hardOutside, "outside-hardlink-sentinel");
        if (!CreateHardLink(Path.Combine(hardRoot, "update.lock"), hardOutside, IntPtr.Zero))
            throw new Exception("Required update.lock hardlink fixture failed: Win32 error " + Marshal.GetLastWin32Error());
        try
        {
            using var hardClient = Client(hardRoot, new QueueTransport(_ => throw new Exception("hardlink reached transport")));
            await Throws(() => hardClient.LoadAsync(), "update.lock hardlink must be rejected");
        }
        catch (ChannelManifestClientException) { assertions++; }
        Equal("outside-hardlink-sentinel", File.ReadAllText(hardOutside));
        using (new FileStream(hardOutside, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) assertions++;

        var symbolicRoot = directory + "-lock-symbolic";
        var symbolicOutside = directory + "-outside-symbolic.lock";
        Directory.CreateDirectory(symbolicRoot);
        File.WriteAllText(symbolicOutside, "outside-symbolic-sentinel");
        try
        {
            File.CreateSymbolicLink(Path.Combine(symbolicRoot, "update.lock"), symbolicOutside);
            try
            {
                using var symbolicClient = Client(symbolicRoot, new QueueTransport(_ => throw new Exception("symbolic link reached transport")));
                await Throws(() => symbolicClient.LoadAsync(), "update.lock symbolic link must be rejected");
            }
            catch (ChannelManifestClientException) { assertions++; }
            Equal("outside-symbolic-sentinel", File.ReadAllText(symbolicOutside));
            using (new FileStream(symbolicOutside, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) assertions++;
        }
        catch (UnauthorizedAccessException) { Console.WriteLine("SKIP update.lock symlink test: no privilege"); }
        catch (IOException exception) { Console.WriteLine("SKIP update.lock symlink test: " + exception.Message); }
        catch (PlatformNotSupportedException) { Console.WriteLine("SKIP update.lock symlink test: unsupported"); }
    }

    private static ChannelManifestClientOptions Options(string directory, long maxBytes = 2 * 1024 * 1024, TimeSpan? timeout = null, Func<string>? uniqueId = null, IChannelManifestSignatureVerifier? verifier = null) => new()
    {
        Url = "https://example.test/channel.json", Channel = "stable", StateRoot = Path.GetFullPath(directory),
        SignatureVerifier = verifier ?? Verifier, MaxResponseBytes = maxBytes,
        Timeout = timeout ?? TimeSpan.FromSeconds(15), UniqueId = uniqueId ?? (() => Guid.NewGuid().ToString("N"))
    };

    private static ChannelManifestClient Client(string directory, IChannelManifestTransport transport, long maxBytes = 2 * 1024 * 1024, TimeSpan? timeout = null, IChannelManifestSignatureVerifier? verifier = null)
    {
        Directory.CreateDirectory(directory);
        return new ChannelManifestClient(Options(directory, maxBytes, timeout, verifier: verifier), transport, true);
    }
    private static string Manifest(string generatedAt)
    {
        var unsigned = new Dictionary<string, object?> { ["schema"] = 1, ["channel"] = "stable", ["generatedAt"] = generatedAt, ["releases"] = Array.Empty<object>() };
        var payload = Encoding.UTF8.GetBytes(OfflineUpdateDecision.CanonicalJson(unsigned)); var signer = new Ed25519Signer(); signer.Init(true, PrivateKey); signer.BlockUpdate(payload, 0, payload.Length);
        unsigned["signature"] = new Dictionary<string, object?> { ["algorithm"] = "ed25519", ["keyId"] = "test-key", ["value"] = Convert.ToBase64String(signer.GenerateSignature()) };
        return JsonSerializer.Serialize(unsigned);
    }

    private static string CorruptSignature(string manifest)
    {
        var root = JsonNode.Parse(manifest)?.AsObject() ?? throw new InvalidOperationException("Invalid manifest fixture.");
        var signature = root["signature"]?["value"]?.GetValue<string>() ?? throw new InvalidOperationException("Missing signature fixture.");
        var bytes = Convert.FromBase64String(signature);
        bytes[0] ^= 0x01;
        root["signature"]!["value"] = Convert.ToBase64String(bytes);
        return root.ToJsonString();
    }

    private static void CorruptCachedManifest(string path)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(path)); var root = document.RootElement;
        var value = new Dictionary<string, object?> { ["schema"] = 1, ["rawManifest"] = CorruptSignature(root.GetProperty("rawManifest").GetString()!), ["etag"] = root.GetProperty("etag").ValueKind == JsonValueKind.Null ? null : root.GetProperty("etag").GetString(), ["lastModified"] = root.GetProperty("lastModified").ValueKind == JsonValueKind.Null ? null : root.GetProperty("lastModified").GetString(), ["verifiedAt"] = root.GetProperty("verifiedAt").GetString(), ["configIdentity"] = root.GetProperty("configIdentity").GetString() };
        File.WriteAllText(path, JsonSerializer.Serialize(value));
    }

    private static HttpResponseMessage Response(HttpStatusCode status, string body, string? etag = null, string? lastModified = null)
    {
        var response = new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        if (etag is not null) response.Headers.ETag = EntityTagHeaderValue.Parse(etag); if (lastModified is not null) response.Content.Headers.LastModified = DateTimeOffset.Parse(lastModified); return response;
    }

    private static HttpResponseMessage BlockingResponse() => new(HttpStatusCode.OK) { Content = new StreamContent(new BlockingReadStream()) };

    private static string[] Quarantines(string directory) => Directory.GetFiles(directory, "cache.corrupt-*.json");

    private static void AddCacheField(string path, string name, object value) => SetCacheField(path, name, value);

    private static void SetCacheField(string path, string name, object value)
    {
        var root = JsonNode.Parse(File.ReadAllText(path))?.AsObject() ?? throw new InvalidOperationException("Invalid cache fixture.");
        root[name] = JsonValue.Create(value);
        File.WriteAllText(path, root.ToJsonString());
    }

    private static async Task Run(string name, Func<string, Task> test)
    {
        var directory = Path.Combine(Path.GetTempPath(), "MagicPot.ChannelManifestClient.SelfTest", Guid.NewGuid().ToString("N"));
        try { await test(directory); Console.WriteLine("PASS " + name); } finally { try { Directory.Delete(directory, true); } catch (Exception) { } }
    }
    private static async Task Throws(Func<Task> action, string message) { try { await action(); } catch (ChannelManifestClientException) { assertions++; return; } throw new Exception("Expected rejection: " + message); }
    private static async Task ThrowsKind(Func<Task> action, ChannelManifestFailureKind expected, string message) { try { await action(); } catch (ChannelManifestClientException exception) { Equal(expected, exception.FailureKind); return; } throw new Exception("Expected rejection: " + message); }
    private static async Task ThrowsCanceled(Func<Task> action, string message) { try { await action(); } catch (OperationCanceledException) { assertions++; return; } throw new Exception("Expected cancellation: " + message); }
    private static void ThrowsClient(Action action, string message) { try { action(); } catch (ChannelManifestClientException) { assertions++; return; } throw new Exception("Expected client rejection: " + message); }
    private static void ThrowsArgument(Action action, string message) { try { action(); } catch (ArgumentException) { assertions++; return; } throw new Exception("Expected argument rejection: " + message); }
    private static void Equal(string expected, string actual) { if (!string.Equals(expected, actual, StringComparison.Ordinal)) throw new Exception("Expected '" + expected + "', got '" + actual + "'."); assertions++; }
    private static void Equal(ChannelManifestFailureKind expected, ChannelManifestFailureKind actual) { if (expected != actual) throw new Exception("Expected '" + expected + "', got '" + actual + "'."); assertions++; }
    private static void True(bool value, string message) { if (!value) throw new Exception(message); assertions++; }

    private sealed class QueueTransport : IChannelManifestTransport
    {
        private readonly Queue<Func<HttpRequestMessage, HttpResponseMessage>> responses;
        public QueueTransport(params Func<HttpRequestMessage, HttpResponseMessage>[] responses) { this.responses = new Queue<Func<HttpRequestMessage, HttpResponseMessage>>(responses); }
        public Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (responses.Count == 0) throw new InvalidOperationException("No queued response.");
            var response = responses.Dequeue()(request);
            response.RequestMessage ??= request;
            return Task.FromResult(response);
        }
        public void Dispose() { }
    }

    private sealed class AsyncTransport : IChannelManifestTransport
    {
        private readonly Func<HttpRequestMessage, Task<HttpResponseMessage>> response;
        public AsyncTransport(Func<HttpRequestMessage, Task<HttpResponseMessage>> response) { this.response = response; }
        public async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var value = await response(request).ConfigureAwait(false);
            value.RequestMessage ??= request;
            return value;
        }
        public void Dispose() { }
    }

    private sealed class MissingUriTransport : IChannelManifestTransport
    {
        private readonly HttpResponseMessage response;
        public MissingUriTransport(HttpResponseMessage response) { this.response = response; }
        public Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => Task.FromResult(response);
        public void Dispose() { response.Dispose(); }
    }

    private sealed class BlockingReadStream : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken).ConfigureAwait(false);
            return 0;
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class ThrowingReadStream : Stream
    {
        private bool returnedPrefix;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count)
        {
            if (returnedPrefix) throw new IOException("simulated disconnect");
            returnedPrefix = true;
            buffer[offset] = (byte)'{';
            return 1;
        }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (returnedPrefix) return ValueTask.FromException<int>(new IOException("simulated disconnect"));
            returnedPrefix = true;
            buffer.Span[0] = (byte)'{';
            return ValueTask.FromResult(1);
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLink(string newFileName, string existingFileName, IntPtr securityAttributes);
}
