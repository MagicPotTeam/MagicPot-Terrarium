using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
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
    private const string ReleaseRoot = "https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/";
    private const string Commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string Build = "20250101-000000-aaaaaaa";
    private static readonly byte[] Seed = Enumerable.Range(1, Ed25519PrivateKeyParameters.KeySize).Select(static value => (byte)value).ToArray();
    private static int unique;

    public static async Task<int> Main()
    {
        if (!OperatingSystem.IsWindows()) { Console.WriteLine("SKIP Windows-only"); return 0; }
        var tests = new (string, Func<Task>)[]
        {
            ("public API/capability", PublicApiAsync), ("app success/dispose", AppAsync), ("runtime ownership", RuntimeAsync),
            ("format", FormatAsync), ("paths", PathsAsync), ("duplicates/modes", StructureAsync), ("budgets", BudgetAsync),
            ("manifest", ManifestAsync), ("CRC corruption", CrcAsync), ("local-central metadata/encrypted flags", HeadersAsync),
            ("uniqueId collision", CollisionAsync), ("pre-tree ancestor release", PreTreeAncestorReleaseAsync), ("failed cleanup ticket/registry", FailedCleanupTicketAsync), ("pinned capability/exclusive observers", PinnedCapabilityAsync), ("ownership transfer", OwnershipTransferAsync), ("ownership race", OwnershipRaceAsync), ("reader cleanup retry", ReaderCleanupRetryAsync), ("directory creation race", DirectoryRaceAsync), ("ancestor creation race", AncestorRaceAsync), ("runtime entrypoint rule", RuntimeEntrypointAsync)
        };
        foreach (var test in tests) try { await test.Item2().ConfigureAwait(false); Console.WriteLine("PASS " + test.Item1); } catch (Exception error) { Console.Error.WriteLine("FAIL " + test.Item1 + ": " + error); return 1; }
        return 0;
    }

    private static Task PublicApiAsync()
    {
        Need(typeof(ArtifactPreparer).IsNotPublic && typeof(ArtifactPreparer).IsSealed);
        Need(typeof(PreparedArtifactPackage).IsNotPublic && typeof(PreparedArtifactLease).IsNotPublic);
        Need(typeof(PreparedArtifactPackage).GetConstructors(BindingFlags.Instance | BindingFlags.Public).Length == 0);
        MethodInfo[] methods = typeof(ArtifactPreparer).GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).Where(static method => method.Name == "PrepareAsync").ToArray();
        Need(methods.Length == 1 && methods[0].IsAssembly && methods[0].GetParameters()[0].ParameterType == typeof(VerifiedArtifactLease));
        return Task.CompletedTask;
    }

    private static async Task AppAsync()
    {
        byte[] app = Encoding.UTF8.GetBytes("app"); string manifest = AppManifest(Build, Commit, "runtime-1", "bin/app.exe", app, true);
        byte[] zip = Zip(("manifest.json", Encoding.UTF8.GetBytes(manifest), 0), ("bin/app.exe", app, 0));
        using var scope = new Scope(); using PreparedArtifactLease prepared = await Prepare(scope, Fixture.App(zip, "app.zip", "bin/app.exe")).ConfigureAwait(false);
        string root = prepared.Root; Need(File.Exists(Path.Combine(root, "bin", "app.exe"))); prepared.Dispose(); Need(!Directory.Exists(root));
    }

    private static async Task RuntimeAsync()
    {
        byte[] py = Encoding.UTF8.GetBytes("py"), comfy = Encoding.UTF8.GetBytes("comfy"); string manifest = RuntimeManifest(py, comfy, "python/python.exe");
        byte[] zip = Zip(("manifest.json", Encoding.UTF8.GetBytes(manifest), 0), ("python/python.exe", py, 0), ("comfy/main.py", comfy, 0));
        using var scope = new Scope(); using PreparedArtifactLease prepared = await Prepare(scope, Fixture.Runtime(zip, "runtime.zip", "python/python.exe")).ConfigureAwait(false);
        Need(File.Exists(Path.Combine(prepared.Root, "python", "python.exe")));
        using PreparedArtifactPackage installerCapability = prepared.TakeOwnership();
        Need(installerCapability.Kind == "runtime" && installerCapability.Manifest is InstalledRuntimeManifestV1);
        Throws<InvalidOperationException>(() => prepared.TakeOwnership());
        prepared.Dispose();
        using Stream read = installerCapability.OpenRead("python/python.exe"); Need(ReadAll(read).SequenceEqual(py));
    }

    private static async Task FormatAsync() { byte[] zip = Zip(("x", [1], 0)); await Reject(Fixture.App(zip, "x.7z", "x.exe")); await Reject(Fixture.App(zip, "x.tar", "x.exe")); }
    private static async Task PathsAsync() { foreach (string name in new[] { "../x", "/x", "C:/x", "a\\b", "CON.txt", "a//b", "a/./b", "a/../b", "trail./x" }) await Reject(Fixture.App(Zip((name, [1], 0)), "x.zip", "x.exe")); }
    private static async Task StructureAsync() { await Reject(Fixture.App(Zip(("a", [1], 0), ("A", [2], 0)), "x.zip", "x.exe")); await Reject(Fixture.App(Zip(("a", [1], 0), ("a/b", [2], 0)), "x.zip", "x.exe")); await Reject(Fixture.App(Zip(("link", [1], 0xA000 << 16)), "x.zip", "x.exe")); await Reject(Fixture.App(Zip(("fifo", [1], 0x1000 << 16)), "x.zip", "x.exe")); }

    private static async Task BudgetAsync()
    {
        byte[] zip = Zip(("a", [1], 0), ("b", [2], 0));
        await Reject(Fixture.App(zip, "x.zip", "x.exe", unpackedSize: 1));
        using var scope = new Scope(); await ThrowsAsync<ArtifactPreparationException>(() => Prepare(scope, Fixture.App(zip, "x.zip", "x.exe"), 1));
    }

    private static async Task ManifestAsync()
    {
        byte[] app = Encoding.UTF8.GetBytes("app");
        await RejectShape(AppManifest(Build, Commit, "other", "bin/app.exe", app, true), app, "bin/app.exe");
        await RejectShape(AppManifest(Build, Commit, "runtime-1", "bin/missing.exe", app, false), app, "bin/missing.exe");
        await RejectShape(AppManifest(Build, Commit, "runtime-1", "bin/app.exe", Encoding.UTF8.GetBytes("bad"), true), app, "bin/app.exe");
    }

    private static async Task CrcAsync()
    {
        byte[] data = Encoding.UTF8.GetBytes("crc-data-that-must-be-read-completely"); byte[] manifestBytes = Encoding.UTF8.GetBytes(AppManifest(Build, Commit, "runtime-1", "bin/app.exe", data, true));
        byte[] zip = Zip(("manifest.json", manifestBytes, 0), ("bin/app.exe", data, 0)); FlipStoredDataByte(zip, "bin/app.exe");
        Fixture fixture = Fixture.App(zip, "crc.zip", "bin/app.exe");
        using var scope = new Scope(); using var transport = new FakeTransport(fixture.Payloads); using var downloader = new ArtifactDownloader(new ArtifactDownloadOptions { StateRoot = scope.Root, Timeout = TimeSpan.FromSeconds(5), LockTimeout = TimeSpan.FromSeconds(5), UniqueId = () => Interlocked.Increment(ref unique).ToString("x") }, transport);
        using VerifiedArtifactLease lease = await downloader.DownloadAsync(fixture.Request).ConfigureAwait(false);
        await ThrowsAsync<ArtifactPreparationException>(() => new ArtifactPreparer(new ArtifactPreparationOptions { StateRoot = scope.Root }).PrepareAsync(lease));
        Need(PreparedEmpty(scope));
    }

    private static async Task HeadersAsync()
    {
        foreach (Action<byte[], string> corrupt in new Action<byte[], string>[] { SetLocalEncryptedFlagOnly, SetCentralEncryptedFlag, MismatchLocalMethod, MismatchLocalCrc, MismatchLocalCompressedSize, MismatchLocalUncompressedSize })
        {
            byte[] zip = ValidAppArtifact(); corrupt(zip, "bin/app.exe"); await Reject(Fixture.App(zip, "headers.zip", "bin/app.exe"));
        }
    }

    private static async Task CollisionAsync()
    {
        byte[] data = Encoding.UTF8.GetBytes("app"); byte[] manifest = Encoding.UTF8.GetBytes(AppManifest(Build, Commit, "runtime-1", "bin/app.exe", data, true)); byte[] zip = Zip(("manifest.json", manifest, 0), ("bin/app.exe", data, 0));
        Fixture fixture = Fixture.App(zip, "collision.zip", "bin/app.exe"); using var scope = new Scope(); string id = "collision";
        string cacheKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(fixture.Proof.RawManifestSha256 + "\n" + Sha(zip)))).ToLowerInvariant();
        string partialName = cacheKey + ".partial-" + id;
        if (partialName.Length > 96) partialName = partialName[..96];
        string existing = Path.Combine(scope.Root, "prepared", partialName); Directory.CreateDirectory(existing); string sentinel = Path.Combine(existing, "sentinel.txt"); File.WriteAllText(sentinel, "do-not-touch");
        await ThrowsAsync<ArtifactPreparationException>(() => Prepare(scope, fixture, uniqueId: () => id));
        Need(File.ReadAllText(sentinel) == "do-not-touch" && Directory.EnumerateFileSystemEntries(existing).Count() == 1);

        using var longScope = new Scope();
        Fixture longFixture = Fixture.App(ValidAppArtifact(), "long-id.zip", "bin/app.exe");
        PreparedArtifactLease longLease = await Prepare(longScope, longFixture, uniqueId: () => new string('x', 100));
        Need(Path.GetFileName(longLease.Root).Length <= 96);
        await longLease.DisposeAsync();
    }

    private static async Task PreTreeAncestorReleaseAsync()
    {
        byte[] zip = ValidAppArtifact(); Fixture fixture = Fixture.App(zip, "pre-tree.zip", "bin/app.exe");
        using var downloadScope = new Scope(); using var transport = new FakeTransport(fixture.Payloads); using var downloader = new ArtifactDownloader(new ArtifactDownloadOptions { StateRoot = downloadScope.Root, Timeout = TimeSpan.FromSeconds(5), LockTimeout = TimeSpan.FromSeconds(5) }, transport);
        using VerifiedArtifactLease downloaded = await downloader.DownloadAsync(fixture.Request).ConfigureAwait(false);
        using (var state = new Scope())
        {
            downloaded.Dispose();
            ArtifactPreparationException disposedError = await CaptureAsync<ArtifactPreparationException>(() => new ArtifactPreparer(new ArtifactPreparationOptions { StateRoot = state.Root }).PrepareAsync(downloaded)); Need(disposedError.InnerException is ObjectDisposedException);
            string moved = state.Root + ".moved"; Directory.Move(state.Root, moved); Directory.Delete(moved, true);
        }
        using (var state = new Scope())
        {
            using var replacement = new VerifiedArtifactLease(downloaded.Path, downloaded.Length, downloaded.Sha256, downloaded.Kind, downloaded.Identity, downloaded.CacheHit, new NonSeekableStream(zip));
            await ThrowsAsync<ArtifactPreparationException>(() => new ArtifactPreparer(new ArtifactPreparationOptions { StateRoot = state.Root }).PrepareAsync(replacement));
            string moved = state.Root + ".moved"; Directory.Move(state.Root, moved); Directory.Delete(moved, true);
        }
        using (var state = new Scope())
        {
            using var replacement = new VerifiedArtifactLease(downloaded.Path, downloaded.Length, downloaded.Sha256, downloaded.Kind, downloaded.Identity, downloaded.CacheHit, new MemoryStream(zip));
            await ThrowsAsync<ArtifactPreparationException>(() => new ArtifactPreparer(new ArtifactPreparationOptions { StateRoot = state.Root, UniqueId = static () => ".." }).PrepareAsync(replacement));
            string moved = state.Root + ".moved"; Directory.Move(state.Root, moved); Directory.Delete(moved, true);
        }
    }

    private static async Task FailedCleanupTicketAsync()
    {
        byte[] zip = ValidAppArtifact(); Fixture fixture = Fixture.App(zip, "cleanup-ticket.zip", "missing.exe"); using var scope = new Scope(); bool blockCleanup = true;
        ArtifactPreparationException error = await CaptureAsync<ArtifactPreparationException>(() => Prepare(scope, fixture, beforeCleanup: () => { if (Volatile.Read(ref blockCleanup)) throw new IOException("transient cleanup failure"); }));
        Need(error.Message.Contains("identity", StringComparison.OrdinalIgnoreCase) && error.CleanupTicket is not null && error.InnerException is ArtifactPreparationException);
        ArtifactCleanupTicket ticket = error.CleanupTicket ?? throw new InvalidOperationException("cleanup ticket missing"); Need(!ticket.CleanupCompleted && ticket.Failures.Count >= 0 && BackgroundPreparedCleanupRegistry.PendingCount == 1);
        string root = Directory.EnumerateDirectories(Path.Combine(scope.Root, "prepared")).Single(); Need(Directory.Exists(root));
        Volatile.Write(ref blockCleanup, false);
        Need(ticket.RetryCleanup(TimeSpan.FromSeconds(5)) && ticket.CleanupCompleted && !Directory.Exists(root) && BackgroundPreparedCleanupRegistry.PendingCount == 0);
        BackgroundPreparedCleanupRegistry.RunOnePass(); Need(BackgroundPreparedCleanupRegistry.PendingCount == 0);
    }

    private static async Task PinnedCapabilityAsync()
    {
        byte[] app = Encoding.UTF8.GetBytes("pinned"); byte[] zip = Zip(("manifest.json", Encoding.UTF8.GetBytes(AppManifest(Build, Commit, "runtime-1", "bin/app.exe", app, true)), 0), ("bin/app.exe", app, 0));
        using var scope = new Scope(); PreparedArtifactLease lease = await Prepare(scope, Fixture.App(zip, "pinned.zip", "bin/app.exe")); string root = lease.Root; string file = Path.Combine(root, "bin", "app.exe");
        Throws<IOException>(() => Directory.Move(root, root + ".moved")); Throws<IOException>(() => Directory.Move(Path.Combine(root, "bin"), Path.Combine(root, "bin-moved"))); Throws<IOException>(() => Directory.Move(Path.Combine(scope.Root, "prepared"), Path.Combine(scope.Root, "prepared-moved"))); Throws<IOException>(() => Directory.Move(scope.Root, scope.Root + ".moved")); Throws<Exception>(() => File.Delete(file)); Throws<Exception>(() => File.Move(file, file + ".moved")); Throws<IOException>(() => File.OpenRead(file));
        Need(lease.Entries.Contains("bin/app.exe", StringComparer.OrdinalIgnoreCase)); using (Stream read = lease.OpenRead("bin/app.exe")) Need(ReadAll(read).SequenceEqual(app));
        using PreparedArtifactPackage package = lease.TakeOwnership(); lease.Dispose();
        Throws<IOException>(() => Directory.Move(root, root + ".moved")); using (Stream read = package.OpenRead("bin/app.exe")) Need(ReadAll(read).SequenceEqual(app));
        package.Dispose(); Need(!Directory.Exists(root));
    }

    private static async Task OwnershipTransferAsync()
    {
        byte[] app = Encoding.UTF8.GetBytes("owned"); byte[] zip = Zip(("manifest.json", Encoding.UTF8.GetBytes(AppManifest(Build, Commit, "runtime-1", "bin/app.exe", app, true)), 0), ("bin/app.exe", app, 0));
        using var scope = new Scope(); PreparedArtifactLease lease = await Prepare(scope, Fixture.App(zip, "owned.zip", "bin/app.exe")); PreparedArtifactPackage package = lease.TakeOwnership(); string root = package.Root;
        Need(lease.OwnershipTransferred && !lease.CleanupCompleted && lease.CleanupFailures.Count == 0);
        Throws<InvalidOperationException>(() => lease.RetryCleanup(TimeSpan.Zero));
        Throws<InvalidOperationException>(() => lease.OpenRead("bin/app.exe"));
        Throws<InvalidOperationException>(() => lease.TakeOwnership());
        lease.Dispose(); await lease.DisposeAsync().ConfigureAwait(false);
        Need(Directory.Exists(root)); using (Stream read = package.OpenRead("bin/app.exe")) Need(ReadAll(read).SequenceEqual(app));
        package.Dispose(); Need(package.CleanupCompleted && !Directory.Exists(root));
    }

    private static async Task OwnershipRaceAsync()
    {
        for (int attempt = 0; attempt < 12; attempt++)
        {
            byte[] app = Encoding.UTF8.GetBytes("race-owner"); byte[] zip = Zip(("manifest.json", Encoding.UTF8.GetBytes(AppManifest(Build, Commit, "runtime-1", "bin/app.exe", app, true)), 0), ("bin/app.exe", app, 0));
            using var scope = new Scope(); PreparedArtifactLease lease = await Prepare(scope, Fixture.App(zip, "owner-race.zip", "bin/app.exe")); string root = lease.Root; using var start = new ManualResetEventSlim(false); PreparedArtifactPackage? package = null; Exception? takeError = null; Exception? cleanupError = null;
            Task take = Task.Run(() => { start.Wait(); try { package = lease.TakeOwnership(); } catch (Exception error) { takeError = error; } });
            Task cleanup = Task.Run(() => { start.Wait(); try { _ = lease.RetryCleanup(TimeSpan.FromSeconds(5)); } catch (Exception error) { cleanupError = error; } });
            start.Set(); await Task.WhenAll(take, cleanup).ConfigureAwait(false);
            if (package is not null)
            {
                Need(takeError is null && cleanupError is InvalidOperationException && lease.OwnershipTransferred && Directory.Exists(root));
                using (Stream read = package.OpenRead("bin/app.exe")) Need(ReadAll(read).SequenceEqual(app));
                lease.Dispose(); Need(Directory.Exists(root)); package.Dispose(); Need(!Directory.Exists(root));
            }
            else
            {
                Need(takeError is InvalidOperationException && cleanupError is null && !lease.OwnershipTransferred && lease.CleanupCompleted && !Directory.Exists(root));
                lease.Dispose();
            }
        }
    }

    private static async Task ReaderCleanupRetryAsync()
    {
        byte[] app = Encoding.UTF8.GetBytes("reader"); byte[] zip = Zip(("manifest.json", Encoding.UTF8.GetBytes(AppManifest(Build, Commit, "runtime-1", "bin/app.exe", app, true)), 0), ("bin/app.exe", app, 0));
        using var scope = new Scope(); PreparedArtifactLease lease = await Prepare(scope, Fixture.App(zip, "reader.zip", "bin/app.exe")); using PreparedArtifactPackage package = lease.TakeOwnership();
        string root = package.Root; Stream first = package.OpenRead("bin/app.exe"); Stream second = package.OpenRead("bin/app.exe"); package.Dispose();
        Need(!package.CleanupCompleted && package.CleanupFailures.Any(static value => value.Contains("active readers", StringComparison.OrdinalIgnoreCase)) && Directory.Exists(root));
        Throws<ObjectDisposedException>(() => package.OpenRead("bin/app.exe"));
        first.Dispose(); first.Dispose(); Need(!package.RetryCleanup(TimeSpan.Zero)); second.Dispose();
        Need(package.RetryCleanup(TimeSpan.FromSeconds(5)) && package.CleanupCompleted && !Directory.Exists(root));
        Need(lease.OwnershipTransferred && !lease.CleanupCompleted && lease.CleanupFailures.Count == 0);
        Throws<InvalidOperationException>(() => lease.RetryCleanup(TimeSpan.Zero));
    }

    private static async Task DirectoryRaceAsync()
    {
        byte[] app = Encoding.UTF8.GetBytes("race"); byte[] zip = Zip(("manifest.json", Encoding.UTF8.GetBytes(AppManifest(Build, Commit, "runtime-1", "bin/app.exe", app, true)), 0), ("bin/app.exe", app, 0));
        using var scope = new Scope(); string external = Path.Combine(scope.Root, "external"); Directory.CreateDirectory(external); bool attacked = false;
        await ThrowsAsync<ArtifactPreparationException>(() => Prepare(scope, Fixture.App(zip, "race.zip", "bin/app.exe"), hook: path => { if (attacked || Path.GetFileName(path) != "bin") return; attacked = true; Directory.Delete(path); Junction(path, external); }));
        Need(!File.Exists(Path.Combine(external, "app.exe")));
    }

    private static async Task AncestorRaceAsync()
    {
        byte[] app = Encoding.UTF8.GetBytes("ancestor"); byte[] zip = Zip(("manifest.json", Encoding.UTF8.GetBytes(AppManifest(Build, Commit, "runtime-1", "bin/app.exe", app, true)), 0), ("bin/app.exe", app, 0));
        string baseRoot = Path.Combine(Path.GetTempPath(), "MagicPot-ancestor-" + Guid.NewGuid().ToString("N")); string state = Path.Combine(baseRoot, "missing", "state"); string external = Path.Combine(baseRoot, "external"); Directory.CreateDirectory(external); bool attacked = false;
        try
        {
            Fixture fixture = Fixture.App(zip, "ancestor.zip", "bin/app.exe"); using var downloadScope = new Scope(); using var transport = new FakeTransport(fixture.Payloads); using var downloader = new ArtifactDownloader(new ArtifactDownloadOptions { StateRoot = downloadScope.Root, Timeout = TimeSpan.FromSeconds(5), LockTimeout = TimeSpan.FromSeconds(5) }, transport); using VerifiedArtifactLease verified = await downloader.DownloadAsync(fixture.Request).ConfigureAwait(false);
            await ThrowsAsync<ArtifactPreparationException>(() => new ArtifactPreparer(new ArtifactPreparationOptions { StateRoot = state, AfterDirectoryCreatedBeforePinned = path => { if (attacked || !string.Equals(path, state, StringComparison.OrdinalIgnoreCase)) return; attacked = true; Directory.Delete(path); Junction(path, external); } }).PrepareAsync(verified));
            Need(!File.Exists(Path.Combine(external, "prepared", "bin", "app.exe")));
        }
        finally { try { Directory.Delete(baseRoot, true); } catch { } }
    }

    private static async Task RuntimeEntrypointAsync()
    {
        byte[] py = Encoding.UTF8.GetBytes("py"), comfy = Encoding.UTF8.GetBytes("comfy"); string manifest = RuntimeManifest(py, comfy, "python/python.exe"); byte[] zip = Zip(("manifest.json", Encoding.UTF8.GetBytes(manifest), 0), ("python/python.exe", py, 0), ("comfy/main.py", comfy, 0));
        using (var scope = new Scope()) using (PreparedArtifactLease prepared = await Prepare(scope, Fixture.Runtime(zip, "runtime-ok.zip", "python/python.exe"))) { Need(prepared.Manifest is InstalledRuntimeManifestV1); }
        // Node channel fixtures use python_embeded/python.exe; the signed runtime artifact entrypoint identifies entrypoints.python, not comfyui.
        await Reject(Fixture.Runtime(zip, "runtime-bad.zip", "comfy/main.py"));
    }

    private static async Task RejectShape(string manifest, byte[] app, string entry)
    {
        byte[] zip = Zip(("manifest.json", Encoding.UTF8.GetBytes(manifest), 0), ("bin/app.exe", app, 0)); using var scope = new Scope();
        await ThrowsAsync<ArtifactPreparationException>(() => Prepare(scope, Fixture.App(zip, "shape.zip", entry))); Need(PreparedEmpty(scope));
    }

    private static async Task Reject(Fixture fixture)
    {
        using var scope = new Scope(); await ThrowsAsync<ArtifactPreparationException>(() => Prepare(scope, fixture)); Need(PreparedEmpty(scope));
    }

    private static async Task<PreparedArtifactLease> Prepare(Scope scope, Fixture fixture, int count = 100_000, Func<string>? uniqueId = null, Action<string>? hook = null, Action? beforeCleanup = null)
    {
        using var transport = new FakeTransport(fixture.Payloads); using var downloader = new ArtifactDownloader(new ArtifactDownloadOptions { StateRoot = scope.Root, Timeout = TimeSpan.FromSeconds(5), LockTimeout = TimeSpan.FromSeconds(5), UniqueId = () => Interlocked.Increment(ref unique).ToString("x") }, transport);
        using VerifiedArtifactLease lease = await downloader.DownloadAsync(fixture.Request).ConfigureAwait(false);
        return await new ArtifactPreparer(new ArtifactPreparationOptions { StateRoot = scope.Root, MaxEntryCount = count, UniqueId = uniqueId, AfterDirectoryCreatedBeforePinned = hook, BeforeCleanupAttempt = beforeCleanup }).PrepareAsync(lease).ConfigureAwait(false);
    }

    private static bool PreparedEmpty(Scope scope) { string path = Path.Combine(scope.Root, "prepared"); return !Directory.Exists(path) || !Directory.EnumerateFileSystemEntries(path).Any(); }
    private static byte[] ReadAll(Stream stream) { using var memory = new MemoryStream(); stream.CopyTo(memory); return memory.ToArray(); }
    private static void Junction(string path, string target) { using Process process = Process.Start(new ProcessStartInfo("cmd.exe", $"/c mklink /J \"{path}\" \"{target}\"") { UseShellExecute = false, CreateNoWindow = true }) ?? throw new InvalidOperationException("cmd start failed"); process.WaitForExit(); Need(process.ExitCode == 0); }
    private static byte[] Zip(params (string Name, byte[] Data, int Attr)[] items) { using var memory = new MemoryStream(); using (var archive = new ZipArchive(memory, ZipArchiveMode.Create, true)) foreach (var item in items) { ZipArchiveEntry entry = archive.CreateEntry(item.Name, CompressionLevel.NoCompression); if (item.Attr != 0) entry.ExternalAttributes = item.Attr; using Stream stream = entry.Open(); stream.Write(item.Data); } return memory.ToArray(); }

    private static byte[] ValidAppArtifact() { byte[] app = Encoding.UTF8.GetBytes("app"); return Zip(("manifest.json", Encoding.UTF8.GetBytes(AppManifest(Build, Commit, "runtime-1", "bin/app.exe", app, true)), 0), ("bin/app.exe", app, 0)); }
    private static void FlipStoredDataByte(byte[] zip, string name) { ZipHeaders headers = FindHeaders(zip, name); Need(U16(zip, headers.Central + 10) == 0); int data = headers.Local + 30 + U16(zip, headers.Local + 26) + U16(zip, headers.Local + 28); zip[data] ^= 1; }
    private static void SetLocalEncryptedFlagOnly(byte[] zip, string name) { ZipHeaders headers = FindHeaders(zip, name); zip[headers.Local + 6] |= 1; }
    private static void SetCentralEncryptedFlag(byte[] zip, string name) { ZipHeaders headers = FindHeaders(zip, name); zip[headers.Central + 8] |= 1; zip[headers.Local + 6] |= 1; }
    private static void MismatchLocalMethod(byte[] zip, string name) { ZipHeaders headers = FindHeaders(zip, name); zip[headers.Local + 8] = zip[headers.Central + 10] == 0 ? (byte)8 : (byte)0; zip[headers.Local + 9] = 0; }
    private static void MismatchLocalCrc(byte[] zip, string name) { ZipHeaders headers = FindHeaders(zip, name); zip[headers.Local + 14] ^= 1; }
    private static void MismatchLocalCompressedSize(byte[] zip, string name) { ZipHeaders headers = FindHeaders(zip, name); zip[headers.Local + 18] ^= 1; }
    private static void MismatchLocalUncompressedSize(byte[] zip, string name) { ZipHeaders headers = FindHeaders(zip, name); zip[headers.Local + 22] ^= 1; }
    private static ZipHeaders FindHeaders(byte[] zip, string name)
    {
        byte[] expected = Encoding.UTF8.GetBytes(name); for (int central = 0; central <= zip.Length - 46; central++) if (U32(zip, central) == 0x02014b50) { int length = U16(zip, central + 28); if (length == expected.Length && zip.AsSpan(central + 46, length).SequenceEqual(expected)) return new ZipHeaders(checked((int)U32(zip, central + 42)), central); } throw new InvalidOperationException("ZIP entry not found");
    }
    private static int U16(byte[] value, int offset) => value[offset] | value[offset + 1] << 8;
    private static uint U32(byte[] value, int offset) => (uint)(value[offset] | value[offset + 1] << 8 | value[offset + 2] << 16 | value[offset + 3] << 24);

    private static string AppManifest(string build, string commit, string runtime, string entry, byte[] data, bool files) { string list = files ? ",\"files\":[{\"path\":\"" + entry + "\",\"size\":" + data.Length + ",\"sha256\":\"" + Sha(data) + "\"}]" : ""; return "{\"schema\":1,\"kind\":\"magicpot-app\",\"version\":\"1.0.0\",\"buildId\":\"" + build + "\",\"commitSha\":\"" + commit + "\",\"platform\":\"win32\",\"arch\":\"x64\",\"runtimeId\":\"" + runtime + "\",\"entrypoint\":\"" + entry + "\",\"createdAt\":\"2025-01-01T00:00:00.000Z\",\"unpackedSize\":" + data.Length + list + "}"; }
    private static string RuntimeManifest(byte[] py, byte[] comfy, string python) => "{\"schema\":1,\"kind\":\"magicpot-runtime\",\"runtimeId\":\"runtime-1\",\"platform\":\"win32\",\"arch\":\"x64\",\"createdAt\":\"2025-01-01T00:00:00.000Z\",\"entrypoints\":{\"python\":\"" + python + "\",\"comfyui\":\"comfy/main.py\"},\"unpackedSize\":" + (py.Length + comfy.Length) + ",\"files\":[{\"path\":\"python/python.exe\",\"size\":" + py.Length + ",\"sha256\":\"" + Sha(py) + "\"},{\"path\":\"comfy/main.py\",\"size\":" + comfy.Length + ",\"sha256\":\"" + Sha(comfy) + "\"}]}";
    private static string Sha(byte[] data) => Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();
    private static void Need(bool condition) { if (!condition) throw new InvalidOperationException("assertion failed"); }
    private static void Throws<T>(Action action) where T : Exception { try { action(); } catch (T) { return; } throw new InvalidOperationException("Expected " + typeof(T).Name); }
    private static async Task ThrowsAsync<T>(Func<Task> action) where T : Exception { try { await action().ConfigureAwait(false); } catch (T) { return; } throw new InvalidOperationException("Expected " + typeof(T).Name); }
    private static async Task<T> CaptureAsync<T>(Func<Task> action) where T : Exception { try { await action().ConfigureAwait(false); } catch (T error) { return error; } throw new InvalidOperationException("Expected " + typeof(T).Name); }

    private sealed class NonSeekableStream(byte[] bytes) : MemoryStream(bytes, false) { public override bool CanSeek => false; public override long Seek(long offset, SeekOrigin loc) => throw new NotSupportedException(); }

    private readonly record struct ZipHeaders(int Local, int Central);

    private sealed class Fixture
    {
        private Fixture(VerifiedChannelManifestProof proof, VerifiedArtifactRequest request, IReadOnlyDictionary<string, byte[]> payloads) { Proof = proof; Request = request; Payloads = payloads; }
        internal VerifiedChannelManifestProof Proof { get; }
        internal VerifiedArtifactRequest Request { get; }
        internal IReadOnlyDictionary<string, byte[]> Payloads { get; }
        internal static Fixture App(byte[] zip, string file, string entrypoint, long? unpackedSize = null) => Create(zip, file, entrypoint, false, unpackedSize);
        internal static Fixture Runtime(byte[] zip, string file, string entrypoint) => Create(zip, file, entrypoint, true, null);

        private static Fixture Create(byte[] target, string file, string entrypoint, bool runtime, long? unpackedSize)
        {
            byte[] companion = runtime ? ValidAppZip() : ValidRuntimeZip();
            string targetUrl = ReleaseRoot + "releases/download/v1/" + file;
            string companionUrl = ReleaseRoot + "releases/download/v1/" + (runtime ? "companion-app.zip" : "companion-runtime.zip");
            Dictionary<string, object?> app = Artifact("app", runtime ? companionUrl : targetUrl, runtime ? companion : target, runtime ? Total(companion) : unpackedSize ?? Total(target), runtime ? "bin/app.exe" : entrypoint);
            Dictionary<string, object?> run = Artifact("runtime", runtime ? targetUrl : companionUrl, runtime ? target : companion, runtime ? Total(target) : Total(companion), runtime ? entrypoint : "python/python.exe");
            var unsigned = new Dictionary<string, object?> { ["schema"] = 1, ["channel"] = "stable", ["generatedAt"] = "2025-01-02T00:00:00.000Z", ["releases"] = new object[] { new Dictionary<string, object?> { ["version"] = "1.0.0", ["buildId"] = Build, ["commitSha"] = Commit, ["publishedAt"] = "2025-01-01T00:00:00.000Z", ["releaseNotesUrl"] = ReleaseRoot + "releases/tag/v1", ["minimumLauncherVersion"] = "1.0.0", ["artifacts"] = new Dictionary<string, object?> { ["app"] = app, ["runtime"] = run } } } };
            const string keyId = "fixed-selftest-key"; var placeholder = new Dictionary<string, object?>(unsigned) { ["signature"] = new Dictionary<string, object?> { ["algorithm"] = "ed25519", ["keyId"] = keyId, ["value"] = Convert.ToBase64String(new byte[64]) } };
            ChannelManifestV1 parsed = OfflineUpdateDecision.ParseChannelManifest(JsonSerializer.Serialize(placeholder), "stable"); byte[] payload = OfflineUpdateDecision.SigningPayload(parsed); var privateKey = new Ed25519PrivateKeyParameters(Seed, 0); var signer = new Ed25519Signer(); signer.Init(true, privateKey); signer.BlockUpdate(payload, 0, payload.Length);
            var signed = new Dictionary<string, object?>(unsigned) { ["signature"] = new Dictionary<string, object?> { ["algorithm"] = "ed25519", ["keyId"] = keyId, ["value"] = Convert.ToBase64String(signer.GenerateSignature()) } }; var verifier = new Ed25519ChannelManifestSignatureVerifier(new Dictionary<string, byte[]> { [keyId] = privateKey.GeneratePublicKey().GetEncoded() });
            VerifiedChannelManifestProof proof = OfflineUpdateDecision.ParseAndVerifyChannelManifest(JsonSerializer.Serialize(signed), "stable", verifier); SelectedArtifactsV1 selection = proof.SelectLatestArtifacts() ?? throw new InvalidOperationException("selection failed"); VerifiedArtifactRequest request = runtime ? proof.CreateRuntimeRequest(selection) : proof.CreateAppRequest(selection);
            return new Fixture(proof, request, new Dictionary<string, byte[]>(StringComparer.Ordinal) { [targetUrl] = target, [companionUrl] = companion });
        }

        private static Dictionary<string, object?> Artifact(string kind, string url, byte[] bytes, long unpacked, string entrypoint)
        {
            var value = new Dictionary<string, object?> { ["kind"] = kind, ["runtimeId"] = "runtime-1", ["platform"] = "win32", ["arch"] = "x64", ["url"] = url, ["sha256"] = Sha(bytes), ["size"] = bytes.Length, ["unpackedSize"] = unpacked, ["entrypoint"] = entrypoint, ["createdAt"] = "2025-01-01T00:00:00.000Z" };
            if (kind == "app") { value["version"] = "1.0.0"; value["buildId"] = Build; value["commitSha"] = Commit; } return value;
        }
        private static long Total(byte[] zip) { using var stream = new MemoryStream(zip); using var archive = new ZipArchive(stream, ZipArchiveMode.Read); return archive.Entries.Sum(static entry => entry.Length); }
        private static byte[] ValidAppZip() { byte[] app = Encoding.UTF8.GetBytes("app"); return Zip(("manifest.json", Encoding.UTF8.GetBytes(AppManifest(Build, Commit, "runtime-1", "bin/app.exe", app, true)), 0), ("bin/app.exe", app, 0)); }
        private static byte[] ValidRuntimeZip() { byte[] py = Encoding.UTF8.GetBytes("py"), comfy = Encoding.UTF8.GetBytes("comfy"); return Zip(("manifest.json", Encoding.UTF8.GetBytes(RuntimeManifest(py, comfy, "python/python.exe")), 0), ("python/python.exe", py, 0), ("comfy/main.py", comfy, 0)); }
    }

    private sealed class FakeTransport(IReadOnlyDictionary<string, byte[]> payloads) : IChannelManifestTransport
    {
        public Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) { cancellationToken.ThrowIfCancellationRequested(); string url = request.RequestUri?.AbsoluteUri ?? throw new InvalidOperationException(); byte[] bytes = payloads[url]; var response = new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = new HttpRequestMessage(HttpMethod.Get, request.RequestUri), Content = new ByteArrayContent(bytes) }; response.Content.Headers.ContentLength = bytes.Length; return Task.FromResult(response); }
        public void Dispose() { }
    }

    private sealed class Scope : IDisposable
    {
        internal Scope() { Root = Path.Combine(Path.GetTempPath(), "MagicPot-preparer-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(Root); }
        internal string Root { get; }
        public void Dispose() { try { if (Directory.Exists(Root)) Directory.Delete(Root, true); } catch (IOException) { } catch (UnauthorizedAccessException) { } }
    }
}
