using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
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
using Microsoft.Win32.SafeHandles;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

internal static class Program
{
    private const string Channel = "stable";
    private const string KeyId = "selftest-key";
    private const string CreatedAt = "2025-01-02T03:04:05.000Z";
    private const string Commit = "0123456789abcdef0123456789abcdef01234567";
    private const string Build = "20250102-030405-0123456";
    private const string Runtime = "python-3.11.9-selftest";
    private const string Origin = "https://selftest.invalid";
    private static readonly byte[] PrivateKey = Convert.FromHexString("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F");
    private static int assertions;

    public static async Task<int> Main()
    {
        if (!OperatingSystem.IsWindows()) { Console.WriteLine("SKIP: Windows-only installer self-test."); return 0; }
        string root = Path.Combine(Path.GetTempPath(), "MagicPot-PreparedInstaller-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            ApiShape();
            await using Chain chain = await Chain.CreateAsync(root).ConfigureAwait(false);
            await SuccessAndIdempotence(chain).ConfigureAwait(false);
            await ActivationLeaseMatrix(chain).ConfigureAwait(false);
            await ExistingDestinationMatrix(chain).ConfigureAwait(false);
            await PartialFailureMatrix(chain).ConfigureAwait(false);
            await NamedMutexLeaseAcrossAwait().ConfigureAwait(false);
            await FileLockRetry(chain).ConfigureAwait(false);
            await ConcurrencyMatrix(chain).ConfigureAwait(false);
            await IdentityReaderAndPublishRaces(chain).ConfigureAwait(false);
            await EmptyFilesRejected(root).ConfigureAwait(false);
            Console.WriteLine($"PASS: complete signed download/prepare/install chain; {assertions} assertions.");
            return 0;
        }
        finally { TryDelete(root); }
    }

    private static void ApiShape()
    {
        Type installer = typeof(PreparedArtifactInstaller);
        Need(installer.IsNotPublic, "installer internal");
        MethodInfo[] methods = installer.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).Where(static m => m.Name == "InstallAsync").ToArray();
        Need(methods.Length == 1, "one InstallAsync");
        ParameterInfo[] parameters = methods[0].GetParameters();
        Need(parameters.Length == 2 && parameters[0].ParameterType == typeof(PreparedArtifactPackage) && parameters[1].ParameterType == typeof(CancellationToken), "InstallAsync shape");
        Need(typeof(PreparedArtifactInstallerOptions).GetProperty("Root", BindingFlags.Instance | BindingFlags.NonPublic) is not null, "internal Root");
        Need(typeof(PreparedArtifactInstallerOptions).GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).All(static p => p.Name is not ("Target" or "TargetPath" or "TargetId")), "no caller target");
        Need(typeof(VerifiedChannelManifestProof).GetConstructors(BindingFlags.Instance | BindingFlags.Public).Length == 0, "proof not publicly constructible");
        Need(typeof(VerifiedArtifactRequest).GetConstructors(BindingFlags.Instance | BindingFlags.Public).Length == 0, "request not publicly constructible");
        Need(typeof(VerifiedArtifactLease).GetConstructors(BindingFlags.Instance | BindingFlags.Public).Length == 0, "lease not publicly constructible");
        Need(typeof(PreparedArtifactPackage).GetConstructors(BindingFlags.Instance | BindingFlags.Public).Length == 0, "package not publicly constructible");
        MethodInfo? launchValidation = typeof(InstalledArtifactReceipt).GetMethod("ValidateImmediatelyBeforeLaunch", BindingFlags.Instance | BindingFlags.NonPublic);
        Need(launchValidation is not null && launchValidation.ReturnType == typeof(void) && launchValidation.GetParameters().Length == 0, "internal immediate launch validation");
        Type verifier = typeof(InstalledTreeVerifier);
        string[] verifierMethods = verifier.GetMethods(BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic).Select(static method => method.Name).ToArray();
        Need(!verifierMethods.Any(static name => name.Contains("Cleanup", StringComparison.OrdinalIgnoreCase) || name.Contains("Delete", StringComparison.OrdinalIgnoreCase) || name.Contains("Publish", StringComparison.OrdinalIgnoreCase)), "existing verifier has no ownership methods");
        Need(typeof(InstallPinnedTree).GetMethod("CreatePartial", BindingFlags.Static | BindingFlags.NonPublic) is not null, "partial tree factory exists");
        Need(typeof(InstallPinnedTree).GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic).All(static method => !method.Name.Contains("Existing", StringComparison.OrdinalIgnoreCase)), "partial tree cannot open existing final");
    }

    private static async Task SuccessAndIdempotence(Chain chain)
    {
        string root = NewInstallRoot(chain.Root, "success");
        File.WriteAllText(Path.Combine(root, "active.json"), "sentinel-active");
        Directory.CreateDirectory(Path.Combine(root, "health"));
        File.WriteAllText(Path.Combine(root, "health", "state.json"), "sentinel-health");
        Directory.CreateDirectory(Path.Combine(root, "journal"));
        File.WriteAllText(Path.Combine(root, "journal", "sentinel"), "sentinel-journal");
        var installer = Installer(root);
        InstalledArtifactReceipt app = await installer.InstallAsync(chain.App).ConfigureAwait(false);
        AssertReceipt(app, "app", Build, Path.Combine(root, "apps", Build), false);
        VerifyInstalled(app.FinalPath, chain.App);
        Need(File.ReadAllText(Path.Combine(root, "active.json")) == "sentinel-active", "active unchanged");
        Need(File.ReadAllText(Path.Combine(root, "health", "state.json")) == "sentinel-health", "health unchanged");
        Need(File.ReadAllText(Path.Combine(root, "journal", "sentinel")) == "sentinel-journal", "journal unchanged");
        InstalledArtifactReceipt runtime = await installer.InstallAsync(chain.Runtime).ConfigureAwait(false);
        AssertReceipt(runtime, "runtime", Runtime, Path.Combine(root, "runtimes", Runtime), false);
        VerifyInstalled(runtime.FinalPath, chain.Runtime);
        Dictionary<string, string> beforeIdempotent = Snapshot(app.FinalPath);
        InstalledFileIdentity appIdentity = app.Identity;
        string appFinal = app.FinalPath;
        app.Dispose();
        InstalledArtifactReceipt again = await installer.InstallAsync(chain.App).ConfigureAwait(false);
        AssertReceipt(again, "app", Build, appFinal, true);
        Need(again.Identity == appIdentity, "idempotent identity stable");
        Need(Directory.Exists(appFinal), "idempotent final remains");
        Need(SnapshotsEqual(Snapshot(appFinal), beforeIdempotent), "idempotent final content unchanged");
        again.Dispose();
        runtime.Dispose();
    }

    private static async Task ActivationLeaseMatrix(Chain chain)
    {
        string root = NewInstallRoot(chain.Root, "activation-lease");
        var installer = Installer(root);
        InstalledArtifactReceipt fresh = await installer.InstallAsync(chain.App).ConfigureAwait(false);
        await AssertActivationLease(fresh, "fresh").ConfigureAwait(false);

        string final = fresh.FinalPath;
        string executable = Path.Combine(final, "MagicPot.exe");
        fresh.Dispose();
        string added = Path.Combine(final, "after-dispose.txt");
        File.WriteAllText(added, "released");
        Need(File.ReadAllText(added) == "released", "dispose restores create access");
        File.Delete(added);
        File.WriteAllText(executable, "after-dispose");
        Need(File.ReadAllText(executable) == "after-dispose", "dispose restores write access");
        string renamedExecutable = Path.Combine(final, "MagicPot-after-dispose.exe");
        File.Move(executable, renamedExecutable);
        Need(File.Exists(renamedExecutable), "dispose restores rename access");
        File.Move(renamedExecutable, executable);
        File.WriteAllText(executable, "selftest-app-exe");

        InstalledArtifactReceipt existing = await installer.InstallAsync(chain.App).ConfigureAwait(false);
        Need(existing.AlreadyInstalled, "activation lease idempotent receipt");
        await AssertActivationLease(existing, "idempotent").ConfigureAwait(false);
        existing.Dispose();
    }

    private static Task AssertActivationLease(InstalledArtifactReceipt receipt, string label)
    {
        string final = receipt.FinalPath;
        string parent = Path.GetDirectoryName(final)!;
        string executable = Path.Combine(final, "MagicPot.exe");
        string child = Path.Combine(final, "data");
        string payload = Path.Combine(child, "payload.txt");
        string movedRoot = final + ".attacker-moved";
        string movedChild = Path.Combine(final, "data-attacker-moved");
        string newFile = Path.Combine(final, "attacker-new.txt");
        string newDirectory = Path.Combine(final, "attacker-new-dir");
        string replacement = Path.Combine(parent, "attacker-replacement-" + Guid.NewGuid().ToString("N") + ".tmp");
        string hardlink = Path.Combine(final, "attacker-hardlink.exe");

        SharingDenied(() => Directory.Move(final, movedRoot), label + " final rename denied");
        SharingDenied(() => Directory.Delete(final, true), label + " final delete denied");
        SharingDenied(() => Directory.Move(child, movedChild), label + " child rename denied");
        SharingDenied(() => Directory.Delete(child, true), label + " child delete denied");
        File.WriteAllText(newFile, "allowed undeclared child");
        Need(File.ReadAllText(newFile) == "allowed undeclared child", label + " create extra file allowed");
        Directory.CreateDirectory(newDirectory);
        Need(Directory.Exists(newDirectory), label + " create extra directory allowed");
        Throws<PreparedArtifactInstallationException>(() => receipt.ValidateImmediatelyBeforeLaunch(), label + " exact tree rejects extras");
        File.Delete(newFile);
        Directory.Delete(newDirectory);
        receipt.ValidateImmediatelyBeforeLaunch();
        SharingDenied(() => File.WriteAllText(executable, "attack"), label + " existing write denied");
        SharingDenied(() => File.Delete(executable), label + " existing delete denied");
        File.WriteAllText(replacement, "replacement");
        try { SharingDenied(() => File.Replace(replacement, executable, null), label + " existing replace denied"); }
        finally { TryDeleteFile(replacement); }
        NativeSharingDenied(() => CreateHardLinkW(hardlink, executable, IntPtr.Zero), label + " hardlink denied");

        using (FileStream input = File.OpenRead(executable))
        {
            Need(Encoding.UTF8.GetString(ReadAll(input)) == "selftest-app-exe", label + " File.OpenRead succeeds");
        }
        Need(File.ReadAllText(payload) == "payload-app", label + " app read succeeds");
        receipt.ValidateForActivation();
        Need(!File.Exists(newFile) && !Directory.Exists(newDirectory) && !File.Exists(hardlink), label + " removed extras restore exact tree");
        return Task.CompletedTask;
    }

    private static byte[] ReadAll(Stream input) { using var output = new MemoryStream(); input.CopyTo(output); return output.ToArray(); }

    private static void SharingDenied(Action action, string label)
    {
        try { action(); }
        catch (IOException) { assertions++; return; }
        catch (UnauthorizedAccessException) { assertions++; return; }
        throw new InvalidOperationException("Expected sharing denial: " + label);
    }

    private static void NativeSharingDenied(Func<bool> action, string label)
    {
        if (action()) throw new InvalidOperationException("Expected sharing denial: " + label);
        int error = Marshal.GetLastWin32Error();
        Need(error is 5 or 32 or 33, label + " Win32 sharing/access denial");
    }

    private static async Task ExistingDestinationMatrix(Chain chain)
    {
        await ExistingFails(chain, "content", path => File.WriteAllText(Path.Combine(path, "MagicPot.exe"), "tampered")).ConfigureAwait(false);
        await ExistingFails(chain, "manifest", path => File.WriteAllText(Path.Combine(path, "manifest.json"), File.ReadAllText(Path.Combine(path, "manifest.json")).Replace(CreatedAt, "2025-01-02T03:04:06.000Z", StringComparison.Ordinal))).ConfigureAwait(false);
        await ExistingFails(chain, "extra-file", path => File.WriteAllText(Path.Combine(path, "extra.bin"), "extra")).ConfigureAwait(false);
        await ExistingFails(chain, "extra-empty-directory", path => Directory.CreateDirectory(Path.Combine(path, "extra-empty"))).ConfigureAwait(false);
        await ExistingFails(chain, "missing", path => File.Delete(Path.Combine(path, "data", "payload.txt"))).ConfigureAwait(false);
        await ExistingFails(chain, "reparse-directory", path =>
        {
            string target = Path.Combine(Path.GetDirectoryName(path)!, "link-target");
            string link = Path.Combine(path, "extra-link");
            Directory.CreateDirectory(target);
            if (!CreateSymbolicLinkW(link, target, 1)) throw new SkippedCaseException();
            try
            {
                if ((File.GetAttributes(link) & FileAttributes.ReparsePoint) == 0) throw new SkippedCaseException();
            }
            catch (FileNotFoundException)
            {
                throw new SkippedCaseException();
            }
        }).ConfigureAwait(false);
        await ExistingFails(chain, "hardlink", path =>
        {
            string source = Path.Combine(path, "MagicPot.exe");
            if (!CreateHardLinkW(Path.Combine(path, "alias.exe"), source, IntPtr.Zero)) throw new SkippedCaseException();
        }).ConfigureAwait(false);
    }

    private static async Task ExistingFails(Chain chain, string name, Action<string> mutate)
    {
        string root = NewInstallRoot(chain.Root, "existing-" + name);
        var installer = Installer(root);
        InstalledArtifactReceipt receipt = await installer.InstallAsync(chain.App).ConfigureAwait(false);
        string finalPath = receipt.FinalPath;
        receipt.Dispose();
        Need(Directory.Exists(finalPath), "receipt dispose preserves existing-test final");
        try { mutate(finalPath); }
        catch (SkippedCaseException) { Console.WriteLine("SKIP optional filesystem capability: " + name); return; }
        Dictionary<string, string> snapshot = Snapshot(finalPath);
        await ThrowsAsync<PreparedArtifactInstallationException>(() => installer.InstallAsync(chain.App), "existing " + name + " fail closed").ConfigureAwait(false);
        Need(SnapshotsEqual(Snapshot(finalPath), snapshot), "existing " + name + " preserved");
        Need(Directory.Exists(finalPath), "existing " + name + " not deleted");
    }

    private static async Task PartialFailureMatrix(Chain chain)
    {
        foreach (bool cancel in new[] { false, true })
        {
            string root = NewInstallRoot(chain.Root, cancel ? "cancel" : "failure");
            using var cts = new CancellationTokenSource();
            var installer = Installer(root, beforeFileCopy: _ => { if (cancel) cts.Cancel(); else throw new IOException("injected"); });
            if (cancel) await ThrowsAsync<OperationCanceledException>(() => installer.InstallAsync(chain.App, cts.Token), "copy cancellation").ConfigureAwait(false);
            else await ThrowsAsync<PreparedArtifactInstallationException>(() => installer.InstallAsync(chain.App), "copy failure").ConfigureAwait(false);
            Need(!Directory.Exists(Path.Combine(root, "apps", Build)), "no final after partial failure");
            Need(!Partials(root).Any(), "partial cleaned");
        }

        string collisionRoot = NewInstallRoot(chain.Root, "collision");
        Directory.CreateDirectory(Path.Combine(collisionRoot, "apps", Build + ".partial-fixed"));
        await ThrowsAsync<PreparedArtifactInstallationException>(() => Installer(collisionRoot, uniqueId: static () => "fixed").InstallAsync(chain.App), "unique ID collision").ConfigureAwait(false);
        Need(Directory.Exists(Path.Combine(collisionRoot, "apps", Build + ".partial-fixed")), "collision object preserved");

        string retryRoot = NewInstallRoot(chain.Root, "cleanup-retry");
        bool block = true;
        var retryInstaller = Installer(
            retryRoot,
            beforePublish: static () => throw new PreparedArtifactInstallationException("before publish"),
            beforeCleanupAttempt: () => { if (block) throw new IOException("block cleanup"); });
        try
        {
            await retryInstaller.InstallAsync(chain.App).ConfigureAwait(false);
            throw new InvalidOperationException("Expected PreparedArtifactInstallationException: cleanup-ticket path");
        }
        catch (PreparedArtifactInstallationException exception)
        {
            assertions++;
            Need(exception.Message == "before publish", "cleanup failure does not mask primary error");
        }
        Need(InstallerCleanupRegistry.PendingCount > 0, "failed cleanup registered");
        Need(Partials(retryRoot).Any(), "failed cleanup preserves partial");
        block = false;
        InstallerCleanupRegistry.RunOnePass();
        Need(InstallerCleanupRegistry.PendingCount == 0, "cleanup registry retry completed");
        Need(!Partials(retryRoot).Any(), "cleanup registry retry removed partial");
    }

    private static async Task NamedMutexLeaseAcrossAwait()
    {
        string name = @"Local\MagicPot.PreparedInstaller.SelfTest." + Guid.NewGuid().ToString("N");
        await using WindowsNamedMutexLease first = await WindowsNamedMutexLease.AcquireAsync(name, TimeSpan.FromSeconds(2), TimeSpan.FromMilliseconds(10), CancellationToken.None).ConfigureAwait(false);
        await Task.Yield();
        using var canceled = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        await ThrowsAsync<OperationCanceledException>(async () =>
        {
            await using WindowsNamedMutexLease blocked = await WindowsNamedMutexLease.AcquireAsync(name, TimeSpan.FromSeconds(2), TimeSpan.FromMilliseconds(10), canceled.Token).ConfigureAwait(false);
        }, "named mutex remains owned across await").ConfigureAwait(false);
    }

    private static async Task FileLockRetry(Chain chain)
    {
        string root = NewInstallRoot(chain.Root, "file-lock-retry");
        string apps = Path.Combine(root, "apps");
        Directory.CreateDirectory(apps);
        string lockPath = Path.Combine(apps, Build + ".install.lock");
        using FileStream blocker = new(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        var installer = new PreparedArtifactInstaller(new PreparedArtifactInstallerOptions
        {
            Root = root,
            LockTimeout = TimeSpan.FromSeconds(2),
            LockRetryDelay = TimeSpan.FromMilliseconds(10)
        });
        Task<InstalledArtifactReceipt> installation = installer.InstallAsync(chain.App);
        await Task.Delay(100).ConfigureAwait(false);
        Need(!installation.IsCompleted, "busy file lock is retried");
        blocker.Dispose();
        using InstalledArtifactReceipt receipt = await installation.ConfigureAwait(false);
        Need(!receipt.AlreadyInstalled, "file lock retry installs after release");
    }

    private static async Task ConcurrencyMatrix(Chain chain)
    {
        string sameRoot = NewInstallRoot(chain.Root, "concurrent-same");
        var gate = new Barrier(2);
        PreparedArtifactInstaller a = Installer(sameRoot, beforeFileCopy: _ => Thread.Sleep(15));
        PreparedArtifactInstaller b = Installer(sameRoot);
        Task<bool> first = Task.Run(async () => { gate.SignalAndWait(); using InstalledArtifactReceipt receipt = await a.InstallAsync(chain.App).ConfigureAwait(false); return receipt.AlreadyInstalled; });
        Task<bool> second = Task.Run(async () => { gate.SignalAndWait(); using InstalledArtifactReceipt receipt = await b.InstallAsync(chain.App).ConfigureAwait(false); return receipt.AlreadyInstalled; });
        bool[] results = await Task.WhenAll(first, second).ConfigureAwait(false);
        Need(results.Count(static already => !already) == 1 && results.Count(static already => already) == 1, "same ID publishes once");
        VerifyInstalled(Path.Combine(sameRoot, "apps", Build), chain.App);

        string parallelRoot = NewInstallRoot(chain.Root, "concurrent-different");
        using var bothEntered = new CountdownEvent(2);
        using var release = new ManualResetEventSlim(false);
        int appEntered = 0, runtimeEntered = 0;
        PreparedArtifactInstaller appInstaller = Installer(parallelRoot, beforeFileCopy: _ => { if (Interlocked.Exchange(ref appEntered, 1) == 0) { bothEntered.Signal(); release.Wait(TimeSpan.FromSeconds(5)); } });
        PreparedArtifactInstaller runtimeInstaller = Installer(parallelRoot, beforeFileCopy: _ => { if (Interlocked.Exchange(ref runtimeEntered, 1) == 0) { bothEntered.Signal(); release.Wait(TimeSpan.FromSeconds(5)); } });
        Task appTask = Task.Run(async () => { using InstalledArtifactReceipt receipt = await appInstaller.InstallAsync(chain.App).ConfigureAwait(false); });
        Task runtimeTask = Task.Run(async () => { using InstalledArtifactReceipt receipt = await runtimeInstaller.InstallAsync(chain.Runtime).ConfigureAwait(false); });
        Need(bothEntered.Wait(TimeSpan.FromSeconds(5)), "different IDs enter copy concurrently");
        release.Set();
        await Task.WhenAll(appTask, runtimeTask).ConfigureAwait(false);
        Need(Directory.Exists(Path.Combine(parallelRoot, "apps", Build)) && Directory.Exists(Path.Combine(parallelRoot, "runtimes", Runtime)), "different IDs installed");
    }

    private static async Task IdentityReaderAndPublishRaces(Chain chain)
    {
        string readerRoot = NewInstallRoot(chain.Root, "reader");
        using Stream reader = chain.App.OpenRead("data/payload.txt");
        byte[] prefix = new byte[3]; Need(reader.Read(prefix, 0, prefix.Length) == 3, "reader begins");
        InstalledArtifactReceipt receipt = await Installer(readerRoot).InstallAsync(chain.App).ConfigureAwait(false);
        using var rest = new MemoryStream(); reader.CopyTo(rest);
        Need(Encoding.UTF8.GetString(prefix.Concat(rest.ToArray()).ToArray()) == "payload-app", "OpenRead remains valid during install");
        Need(InstallNative.Normalize(receipt.FinalPath) == receipt.FinalPath, "receipt final canonical");
        using SafeFileHandle handle = InstallNative.OpenDirectory(receipt.FinalPath, InstallNative.ReadAttributes, FileShare.ReadWrite);
        Need(InstallNative.Identity(handle) == receipt.Identity, "receipt file identity exact");
        receipt.Dispose();

        string raceRoot = NewInstallRoot(chain.Root, "publish-race");
        string final = Path.Combine(raceRoot, "apps", Build);
        var racing = Installer(raceRoot, beforePublish: () => { Directory.CreateDirectory(final); File.WriteAllText(Path.Combine(final, "attacker.txt"), "keep"); });
        await ThrowsAsync<PreparedArtifactInstallationException>(() => racing.InstallAsync(chain.App), "beforePublish final race").ConfigureAwait(false);
        Need(File.ReadAllText(Path.Combine(final, "attacker.txt")) == "keep", "racing final preserved");
        Need(!Partials(raceRoot).Any(), "race partial cleaned");

        string normalMoveRoot = NewInstallRoot(chain.Root, "normal-move");
        InstalledArtifactReceipt normalMove = await Installer(normalMoveRoot, afterMoveBeforeReopen: static () => { }).InstallAsync(chain.App).ConfigureAwait(false);
        AssertReceipt(normalMove, "app", Build, Path.Combine(normalMoveRoot, "apps", Build), false);
        VerifyInstalled(normalMove.FinalPath, chain.App);
        normalMove.ValidateForActivation();
        string extraAfterInstall = Path.Combine(normalMove.FinalPath, "extra-after-install.txt");
        File.WriteAllText(extraAfterInstall, "extra");
        Throws<PreparedArtifactInstallationException>(() => normalMove.ValidateImmediatelyBeforeLaunch(), "activation validation rejects added extra");
        File.Delete(extraAfterInstall);
        normalMove.ValidateImmediatelyBeforeLaunch();
        string normalFinal = normalMove.FinalPath;
        normalMove.Dispose();
        Need(Directory.Exists(normalFinal), "receipt dispose retains final");

        string writeRoot = NewInstallRoot(chain.Root, "post-move-write");
        string writeFinal = Path.Combine(writeRoot, "apps", Build);
        bool writeSucceeded = false;
        await ThrowsAsync<PreparedArtifactInstallationException>(() => Installer(writeRoot, afterMoveBeforeReopen: () =>
        {
            File.WriteAllText(Path.Combine(writeFinal, "MagicPot.exe"), "tampered");
            writeSucceeded = true;
        }).InstallAsync(chain.App), "post-move write rejected by snapshot verification").ConfigureAwait(false);
        Need(writeSucceeded, "post-move hook runs after close and before repin");
        Need(Directory.Exists(writeFinal), "post-move write orphan final preserved");

        await PostMoveReplacementFails(chain, "same-bytes", "selftest-app-exe").ConfigureAwait(false);
        await PostMoveReplacementFails(chain, "different-bytes", "attacker-content").ConfigureAwait(false);

        string beforeMoveRoot = NewInstallRoot(chain.Root, "before-move-replacement");
        string beforeMoveRenamed = Path.Combine(beforeMoveRoot, "attacker-before-move-original.exe");
        await ThrowsAsync<PreparedArtifactInstallationException>(() => Installer(beforeMoveRoot, beforePublish: () =>
        {
            string partial = Partials(beforeMoveRoot).Single();
            string executable = Path.Combine(partial, "MagicPot.exe");
            File.Move(executable, beforeMoveRenamed);
            File.WriteAllText(executable, "selftest-app-exe");
        }).InstallAsync(chain.App), "before-move replacement fails closed").ConfigureAwait(false);
        Need(!Directory.Exists(Path.Combine(beforeMoveRoot, "apps", Build)), "before-move attack publishes no final");

        string identityRoot = NewInstallRoot(chain.Root, "identity");
        string otherBuild = "20250102-030406-0123456";
        SetAutoProperty(chain.App.Identity, "BuildId", otherBuild);
        try
        {
            await ThrowsAsync<PreparedArtifactInstallationException>(() => Installer(identityRoot).InstallAsync(chain.App), "identity cannot override manifest").ConfigureAwait(false);
            Need(!Directory.Exists(Path.Combine(identityRoot, "apps", otherBuild)) && !Directory.Exists(Path.Combine(identityRoot, "apps", Build)), "identity mismatch publishes nowhere");
        }
        finally { SetAutoProperty(chain.App.Identity, "BuildId", Build); }
    }

    private static async Task PostMoveReplacementFails(Chain chain, string name, string replacementContent)
    {
        string root = NewInstallRoot(chain.Root, "post-move-" + name);
        string final = Path.Combine(root, "apps", Build);
        string renamed = Path.Combine(final, "attacker-original.exe");
        await ThrowsAsync<PreparedArtifactInstallationException>(() => Installer(root, afterMoveBeforeReopen: () =>
        {
            string executable = Path.Combine(final, "MagicPot.exe");
            File.Move(executable, renamed);
            File.WriteAllText(executable, replacementContent);
        }).InstallAsync(chain.App), "post-move " + name + " replacement fails closed").ConfigureAwait(false);
        Need(Directory.Exists(final), "post-move " + name + " final preserved");
        Need(File.Exists(renamed) && File.Exists(Path.Combine(final, "MagicPot.exe")), "post-move " + name + " attacker tree not deleted");
        Need(File.ReadAllText(Path.Combine(final, "MagicPot.exe")) == replacementContent, "post-move " + name + " attacker replacement not overwritten");
    }

    private static async Task EmptyFilesRejected(string root)
    {
        await using Chain empty = await Chain.CreateAsync(Path.Combine(root, "empty-chain"), emptyFiles: true).ConfigureAwait(false);
        string installRoot = NewInstallRoot(root, "empty-files");
        await ThrowsAsync<PreparedArtifactInstallationException>(() => Installer(installRoot).InstallAsync(empty.App), "manifest.files empty rejected").ConfigureAwait(false);
        Need(!Directory.Exists(Path.Combine(installRoot, "apps", Build)), "empty files no publish");
    }

    private static PreparedArtifactInstaller Installer(string root, Func<string>? uniqueId = null, Action<string>? beforeFileCopy = null, Action? beforePublish = null, Action? beforeCleanupAttempt = null, Action? afterMoveBeforeReopen = null) =>
        new(new PreparedArtifactInstallerOptions { Root = root, LockTimeout = TimeSpan.FromSeconds(10), LockRetryDelay = TimeSpan.FromMilliseconds(10), UniqueId = uniqueId, BeforeFileCopy = beforeFileCopy, BeforePublish = beforePublish, BeforeCleanupAttempt = beforeCleanupAttempt, AfterMoveBeforeReopen = afterMoveBeforeReopen });

    private static string NewInstallRoot(string parent, string name) { string path = Path.Combine(parent, "install-" + name); Directory.CreateDirectory(path); return path; }
    private static IEnumerable<string> Partials(string root) => Directory.Exists(Path.Combine(root, "apps")) ? Directory.EnumerateDirectories(Path.Combine(root, "apps"), "*.partial-*") : Array.Empty<string>();

    private static void AssertReceipt(InstalledArtifactReceipt receipt, string kind, string id, string final, bool already)
    {
        Need(receipt.Kind == kind && receipt.Id == id, "receipt kind/id");
        Need(string.Equals(receipt.FinalPath, InstallNative.Normalize(final), StringComparison.OrdinalIgnoreCase), "receipt final path");
        Need(receipt.AlreadyInstalled == already, "receipt idempotence");
        Need(receipt.Identity.VolumeSerialNumber != 0 && receipt.Identity.FileId != 0, "receipt identity nonzero");
    }

    private static void VerifyInstalled(string final, PreparedArtifactPackage package)
    {
        Need(Directory.Exists(final), "final exists");
        string[] actual = Directory.EnumerateFiles(final, "*", SearchOption.AllDirectories).Select(path => Path.GetRelativePath(final, path).Replace('\\', '/')).OrderBy(static x => x, StringComparer.OrdinalIgnoreCase).ToArray();
        Need(actual.SequenceEqual(package.Entries.OrderBy(static x => x, StringComparer.OrdinalIgnoreCase), StringComparer.OrdinalIgnoreCase), "installed entries exact");
        foreach (string entry in package.Entries)
        {
            using Stream expected = package.OpenRead(entry); using FileStream value = File.OpenRead(Path.Combine(final, entry.Replace('/', Path.DirectorySeparatorChar)));
            Need(SHA256.HashData(expected).SequenceEqual(SHA256.HashData(value)), "installed file hash " + entry);
        }
        object parsed = package.Kind == "app" ? Protocol.ParseAppManifest(File.ReadAllText(Path.Combine(final, "manifest.json"))) : Protocol.ParseRuntimeManifest(File.ReadAllText(Path.Combine(final, "manifest.json")));
        Need(Protocol.Serialize(parsed) == Protocol.Serialize(package.Manifest), "installed manifest parsed equality");
    }

    private static Dictionary<string, string> Snapshot(string root) => Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories).ToDictionary(path => Path.GetRelativePath(root, path), path => Directory.Exists(path) ? "D" : Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))), StringComparer.OrdinalIgnoreCase);
    private static bool SnapshotsEqual(IReadOnlyDictionary<string, string> left, IReadOnlyDictionary<string, string> right) => left.Count == right.Count && left.All(pair => right.TryGetValue(pair.Key, out string? value) && value == pair.Value);

    private static void SetAutoProperty(object instance, string name, object? value)
    {
        FieldInfo field = instance.GetType().GetField("<" + name + ">k__BackingField", BindingFlags.Instance | BindingFlags.NonPublic) ?? throw new InvalidOperationException("Backing field not found: " + name);
        field.SetValue(instance, value);
    }

    private static async Task ThrowsAsync<T>(Func<Task> action, string label) where T : Exception
    {
        try { await action().ConfigureAwait(false); }
        catch (T) { assertions++; return; }
        throw new InvalidOperationException("Expected " + typeof(T).Name + ": " + label);
    }

    private static void Throws<T>(Action action, string label) where T : Exception
    {
        try { action(); }
        catch (T) { assertions++; return; }
        throw new InvalidOperationException("Expected " + typeof(T).Name + ": " + label);
    }

    private static void Need(bool condition, string label) { assertions++; if (!condition) throw new InvalidOperationException("Self-test assertion failed: " + label); }
    private static void TryDelete(string path) { try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch { } }
    private static void TryDeleteFile(string path) { try { File.Delete(path); } catch { } }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateHardLinkW(string newFileName, string existingFileName, IntPtr securityAttributes);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateSymbolicLinkW(string symlinkFileName, string targetFileName, int flags);

    private sealed class SkippedCaseException : Exception { }

    private sealed class FakeTransport : IChannelManifestTransport
    {
        private readonly IReadOnlyDictionary<string, byte[]> bodies;
        internal FakeTransport(IReadOnlyDictionary<string, byte[]> bodies) => this.bodies = bodies;
        public Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Uri uri = request.RequestUri ?? throw new InvalidOperationException("missing URI");
            if (!bodies.TryGetValue(uri.AbsoluteUri, out byte[]? body)) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound) { RequestMessage = request });
            var response = new HttpResponseMessage(HttpStatusCode.OK) { RequestMessage = new HttpRequestMessage(request.Method, uri), Content = new ByteArrayContent(body) };
            response.Content.Headers.ContentLength = body.Length;
            return Task.FromResult(response);
        }
        public void Dispose() { }
    }

    private sealed class Chain : IAsyncDisposable
    {
        private readonly ArtifactDownloader downloader;
        private readonly PreparedArtifactLease appLease;
        private readonly PreparedArtifactLease runtimeLease;
        internal Chain(string root, ArtifactDownloader downloader, VerifiedArtifactLease appDownload, VerifiedArtifactLease runtimeDownload, PreparedArtifactLease appLease, PreparedArtifactLease runtimeLease)
        {
            Root = root; this.downloader = downloader; AppDownload = appDownload; RuntimeDownload = runtimeDownload; this.appLease = appLease; this.runtimeLease = runtimeLease;
            App = appLease.TakeOwnership(); Runtime = runtimeLease.TakeOwnership();
        }
        internal string Root { get; }
        internal VerifiedArtifactLease AppDownload { get; }
        internal VerifiedArtifactLease RuntimeDownload { get; }
        internal PreparedArtifactPackage App { get; }
        internal PreparedArtifactPackage Runtime { get; }

        internal static async Task<Chain> CreateAsync(string root, bool emptyFiles = false)
        {
            Directory.CreateDirectory(root);
            byte[] appZip = MakeAppZip(emptyFiles);
            byte[] runtimeZip = MakeRuntimeZip();
            string appUrl = Origin + "/owner/repo/releases/download/v1/app.zip";
            string runtimeUrl = Origin + "/owner/repo/releases/download/v1/runtime.zip";
            string manifestUrl = Origin + "/owner/repo/releases/channel.json";
            string raw = SignManifest(appUrl, appZip, runtimeUrl, runtimeZip, emptyFiles);
            var bodies = new Dictionary<string, byte[]>(StringComparer.Ordinal) { [manifestUrl] = Encoding.UTF8.GetBytes(raw), [appUrl] = appZip, [runtimeUrl] = runtimeZip };
            var transport = new FakeTransport(bodies);
            var privateKey = new Ed25519PrivateKeyParameters(PrivateKey, 0);
            var verifier = new Ed25519ChannelManifestSignatureVerifier(new Dictionary<string, byte[]> { [KeyId] = privateKey.GeneratePublicKey().GetEncoded() });
            var trusted = new[] { new TrustedReleaseSource(Origin, "/owner/repo/") };
            using var client = new ChannelManifestClient(new ChannelManifestClientOptions { Url = manifestUrl, Channel = Channel, StateRoot = Path.Combine(root, "manifest-state"), SignatureVerifier = verifier, TrustedSources = trusted }, transport);
            ChannelManifestLoadResult loaded = await client.LoadAsync().ConfigureAwait(false);
            Need(loaded.Source == "network", "manifest loaded through transport");
            SelectedArtifactsV1 selection = loaded.Proof.SelectLatestArtifacts() ?? throw new InvalidOperationException("selection missing");
            (VerifiedArtifactRequest appRequest, VerifiedArtifactRequest runtimeRequest) = loaded.Proof.CreateRequests(selection);
            var downloader = new ArtifactDownloader(new ArtifactDownloadOptions { StateRoot = Path.Combine(root, "download-state"), TrustedSources = trusted }, transport);
            VerifiedArtifactLease appDownload = await downloader.DownloadAsync(appRequest).ConfigureAwait(false);
            VerifiedArtifactLease runtimeDownload = await downloader.DownloadAsync(runtimeRequest).ConfigureAwait(false);
            var preparer = new ArtifactPreparer(new ArtifactPreparationOptions { StateRoot = Path.Combine(root, "prepare-state") });
            PreparedArtifactLease appLease = await preparer.PrepareAsync(appDownload).ConfigureAwait(false);
            PreparedArtifactLease runtimeLease = await preparer.PrepareAsync(runtimeDownload).ConfigureAwait(false);
            return new Chain(root, downloader, appDownload, runtimeDownload, appLease, runtimeLease);
        }

        public async ValueTask DisposeAsync()
        {
            await App.DisposeAsync().ConfigureAwait(false); await Runtime.DisposeAsync().ConfigureAwait(false);
            await AppDownload.DisposeAsync().ConfigureAwait(false); await RuntimeDownload.DisposeAsync().ConfigureAwait(false);
            await appLease.DisposeAsync().ConfigureAwait(false); await runtimeLease.DisposeAsync().ConfigureAwait(false); downloader.Dispose();
        }
    }

    private static byte[] MakeAppZip(bool emptyFiles)
    {
        var payload = new Dictionary<string, byte[]> { ["MagicPot.exe"] = Encoding.UTF8.GetBytes("selftest-app-exe"), ["data/payload.txt"] = Encoding.UTF8.GetBytes("payload-app") };
        return MakeZip(payload, files => new InstalledAppManifestV1(1, "magicpot-app", "1.2.3", Build, Commit, "win32", "x64", Runtime, "MagicPot.exe", CreatedAt, payload.Values.Sum(static x => (long)x.Length), emptyFiles ? null : files));
    }

    private static byte[] MakeRuntimeZip()
    {
        var payload = new Dictionary<string, byte[]> { ["python/python.exe"] = Encoding.UTF8.GetBytes("selftest-python"), ["comfy/main.py"] = Encoding.UTF8.GetBytes("print('selftest')") };
        return MakeZip(payload, files => new InstalledRuntimeManifestV1(1, "magicpot-runtime", Runtime, "win32", "x64", CreatedAt, new RuntimeEntrypointsV1("python/python.exe", "comfy/main.py"), payload.Values.Sum(static x => (long)x.Length), files));
    }

    private static byte[] MakeZip(Dictionary<string, byte[]> payload, Func<IReadOnlyList<InstalledFileV1>, object> manifestFactory)
    {
        IReadOnlyList<InstalledFileV1> files = payload.Select(static pair => new InstalledFileV1(pair.Key, pair.Value.Length, Convert.ToHexString(SHA256.HashData(pair.Value)).ToLowerInvariant())).ToArray();
        byte[] manifest = Encoding.UTF8.GetBytes(Protocol.Serialize(manifestFactory(files)));
        using var output = new MemoryStream();
        using (var archive = new ZipArchive(output, ZipArchiveMode.Create, true, Encoding.UTF8))
        {
            foreach (KeyValuePair<string, byte[]> pair in payload)
            {
                ZipArchiveEntry entry = archive.CreateEntry(pair.Key, CompressionLevel.NoCompression); entry.ExternalAttributes = 0x20;
                using Stream stream = entry.Open(); stream.Write(pair.Value);
            }
            ZipArchiveEntry manifestEntry = archive.CreateEntry("manifest.json", CompressionLevel.NoCompression); manifestEntry.ExternalAttributes = 0x20;
            using Stream manifestStream = manifestEntry.Open(); manifestStream.Write(manifest);
        }
        return output.ToArray();
    }

    private static string SignManifest(string appUrl, byte[] appZip, string runtimeUrl, byte[] runtimeZip, bool emptyFiles)
    {
        long appPayload = "selftest-app-exe".Length + "payload-app".Length;
        long runtimePayload = "selftest-python".Length + "print('selftest')".Length;
        long appUnpacked = appPayload + Encoding.UTF8.GetByteCount(Protocol.Serialize(new InstalledAppManifestV1(1, "magicpot-app", "1.2.3", Build, Commit, "win32", "x64", Runtime, "MagicPot.exe", CreatedAt, appPayload, emptyFiles ? null : new[] { FileRecord("MagicPot.exe", "selftest-app-exe"), FileRecord("data/payload.txt", "payload-app") })));
        long runtimeUnpacked = runtimePayload + Encoding.UTF8.GetByteCount(Protocol.Serialize(new InstalledRuntimeManifestV1(1, "magicpot-runtime", Runtime, "win32", "x64", CreatedAt, new RuntimeEntrypointsV1("python/python.exe", "comfy/main.py"), runtimePayload, new[] { FileRecord("python/python.exe", "selftest-python"), FileRecord("comfy/main.py", "print('selftest')") })));
        var app = new AppArtifactV1("app", "1.2.3", Build, Commit, Runtime, "win32", "x64", appUrl, Hash(appZip), appZip.Length, appUnpacked, "MagicPot.exe", CreatedAt);
        var runtime = new RuntimeArtifactV1("runtime", Runtime, "win32", "x64", runtimeUrl, Hash(runtimeZip), runtimeZip.Length, runtimeUnpacked, "python/python.exe", CreatedAt);
        var unsigned = new ChannelManifestV1(1, Channel, CreatedAt, new[] { new ChannelReleaseV1("1.2.3", Build, Commit, CreatedAt, Origin + "/owner/repo/releases/tag/v1", "1.0.0", new ReleaseArtifactsV1(app, runtime)) }, new ManifestSignatureV1("ed25519", KeyId, Convert.ToBase64String(new byte[64])));
        byte[] payload = OfflineUpdateDecision.SigningPayload(unsigned);
        var signer = new Ed25519Signer(); signer.Init(true, new Ed25519PrivateKeyParameters(PrivateKey, 0)); signer.BlockUpdate(payload, 0, payload.Length);
        ChannelManifestV1 signed = unsigned with { Signature = new ManifestSignatureV1("ed25519", KeyId, Convert.ToBase64String(signer.GenerateSignature())) };
        return JsonSerializer.Serialize(signed, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
    }

    private static InstalledFileV1 FileRecord(string path, string content) { byte[] bytes = Encoding.UTF8.GetBytes(content); return new InstalledFileV1(path, bytes.Length, Hash(bytes)); }
    private static string Hash(byte[] value) => Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();
}
