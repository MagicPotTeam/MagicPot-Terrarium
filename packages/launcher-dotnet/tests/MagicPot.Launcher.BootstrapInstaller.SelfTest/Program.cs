using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
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
    private static int assertions;
    private static async Task<int> Main()
    {
        if (!OperatingSystem.IsWindows()) return 0;
        string temp = Path.Combine(Path.GetTempPath(), "MagicPot-Bootstrap-SelfTest-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(temp);
        try
        {
            TrustSurface(); RootPolicy(temp); await RealInstallAndRecovery(temp); StateAndUninstall(temp);
            Console.WriteLine("BootstrapInstaller.SelfTest PASS: " + assertions + " assertions"); return 0;
        }
        finally { try { Directory.Delete(temp, true); } catch { } }
    }

    private static void TrustSurface()
    {
        BootstrapTrustConfiguration disabled = BootstrapTrustConfiguration.Disabled; BootstrapTrustConfiguration compiled = CompiledBootstrapTrustConfiguration.Create();
        Need(!disabled.Enabled, "default trust disabled"); Need(disabled.Identity.Contains("disabled", StringComparison.Ordinal), "disabled identity"); Need(compiled.Enabled, "self-test compiled trust enabled");
        Need(typeof(BootstrapTrustConfiguration).IsSealed && !typeof(BootstrapTrustConfiguration).IsPublic, "trust internal sealed");
        Need(typeof(VerifiedBootstrapBundle).GetConstructors(BindingFlags.Public | BindingFlags.Instance).Length == 0, "bundle has no public constructor");
        MethodInfo verify = typeof(VerifiedBootstrapBundle).GetMethod("VerifyBootstrapDescriptor", BindingFlags.Static | BindingFlags.NonPublic)!;
        Need(verify.GetParameters().Length == 3, "verify resolves signed colocated payload names"); Need(verify.GetParameters().All(p => p.ParameterType != typeof(BootstrapTrustConfiguration)), "verify cannot inject trust");
        Need(BootstrapInstallerCore.OwnershipFileName == "install-ownership.json", "fixed ownership name"); Need(BootstrapInstallerCore.JournalFileName == "bootstrap-install-journal.json", "fixed journal name");
        Need(typeof(UninstallCapability).IsSealed, "uninstall capability sealed"); Need(typeof(UninstallCapability).GetMethod("ValidateStillOwned", BindingFlags.Instance | BindingFlags.NonPublic) is not null, "uninstall validation exists"); Need(typeof(UninstallOwnedEntry).GetProperty("Length", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic) is not null, "uninstall length recorded"); Need(typeof(UninstallOwnedEntry).GetProperty("Sha256", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic) is not null, "uninstall hash recorded"); Need(typeof(UninstallOwnedEntry).GetProperty("DirectoryFingerprint", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic) is not null, "directory fingerprint recorded");
    }

    private static void RootPolicy(string temp)
    {
        var integration = new FakeIntegration(); string root = Path.Combine(temp, "policy", "nested", "install"); var core = new BootstrapInstallerCore(new BootstrapInstallerOptions { AbsoluteInstallRoot = root, Integration = integration });
        Need(core.Root == Path.GetFullPath(root), "canonical root"); Need(core.LauncherExe.EndsWith(Path.Combine("Launcher", "MagicPot.Launcher.exe"), StringComparison.Ordinal), "fixed launcher"); Need(core.UninstallerExe.EndsWith(Path.Combine("Launcher", "MagicPot.Uninstall.exe"), StringComparison.Ordinal), "fixed uninstaller");
        Reject(() => new BootstrapInstallerCore(new BootstrapInstallerOptions { AbsoluteInstallRoot = "relative", Integration = integration }), "relative root");
        Reject(() => new BootstrapInstallerCore(new BootstrapInstallerOptions { AbsoluteInstallRoot = Path.GetPathRoot(root)!, Integration = integration }), "volume root");
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows); if (!string.IsNullOrEmpty(windows)) Reject(() => new BootstrapInstallerCore(new BootstrapInstallerOptions { AbsoluteInstallRoot = Path.Combine(windows, "MagicPot"), Integration = integration }), "Windows root");
        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles); if (!string.IsNullOrEmpty(programFiles)) Reject(() => new BootstrapInstallerCore(new BootstrapInstallerOptions { AbsoluteInstallRoot = Path.Combine(programFiles, "MagicPot"), Integration = integration }), "Program Files root");
        Need(!Directory.Exists(root), "constructor does not create root");
    }

    private static async Task RealInstallAndRecovery(string temp)
    {
        Fixture fixture = Fixture.Create(temp); BootstrapTrustConfiguration compiled = CompiledBootstrapTrustConfiguration.Create(); Need(compiled.Enabled, "test trust enabled"); Need(compiled.Identity.StartsWith("bootstrap-trust-v1:", StringComparison.Ordinal), "enabled trust identity");
        byte[] wrong = (byte[])fixture.DescriptorBytes.Clone(); wrong[^1] ^= 1; Reject(() => VerifiedBootstrapBundle.VerifyBootstrapDescriptor(wrong, fixture.DescriptorSignature, Path.GetDirectoryName(fixture.LauncherPath)!), "descriptor tamper");
        byte[] wrongSignature = (byte[])fixture.DescriptorSignature.Clone(); wrongSignature[0] ^= 1; Reject(() => VerifiedBootstrapBundle.VerifyBootstrapDescriptor(fixture.DescriptorBytes, wrongSignature, Path.GetDirectoryName(fixture.LauncherPath)!), "wrong descriptor signature");
        byte[] wrongUninstallerDescriptor = fixture.CreateDescriptor(new string('d', 64)); byte[] wrongUninstallerSignature = fixture.SignDescriptor(wrongUninstallerDescriptor);
        Reject(() => VerifiedBootstrapBundle.VerifyBootstrapDescriptor(wrongUninstallerDescriptor, wrongUninstallerSignature, Path.GetDirectoryName(fixture.LauncherPath)!), "wrong uninstaller hash");
        byte[] uninstallerAltered = fixture.CreateDescriptor(new string('e', 64)); Reject(() => VerifiedBootstrapBundle.VerifyBootstrapDescriptor(uninstallerAltered, fixture.DescriptorSignature, Path.GetDirectoryName(fixture.LauncherPath)!), "unsigned uninstaller identity change");
        byte[] traversalDescriptor = Encoding.UTF8.GetBytes(Encoding.UTF8.GetString(fixture.CreateDescriptor(fixture.UninstallerSha)).Replace("MagicPot.Launcher.exe", "../MagicPot.Launcher.exe", StringComparison.Ordinal)); Reject(() => VerifiedBootstrapBundle.VerifyBootstrapDescriptor(traversalDescriptor, fixture.SignDescriptor(traversalDescriptor), Path.GetDirectoryName(fixture.LauncherPath)!), "launcher traversal sourcePath");
        using VerifiedBootstrapBundle bundle = VerifiedBootstrapBundle.VerifyBootstrapDescriptor(fixture.DescriptorBytes, fixture.DescriptorSignature, Path.GetDirectoryName(fixture.LauncherPath)!);
        Need(bundle.ConfigurationIdentity == compiled.Identity, "bundle config identity"); Need(bundle.ChannelProof.VerifierIdentity == compiled.ManifestVerifier.VerifierIdentity, "manifest verifier identity"); Need(bundle.DescriptorIdentity.Length == 64, "descriptor digest"); Need(bundle.Selection.App.BuildId.EndsWith("aaaaaaa", StringComparison.Ordinal), "selected app"); Need(bundle.Selection.Runtime.RuntimeId == "runtime-1", "selected runtime");

        string root = Path.Combine(temp, "success"); var integration = new FakeIntegration(); string installId = Guid.NewGuid().ToString("N"); int pipelineCalls = 0;
        BootstrapInstallerOptions Options(Action<string>? crash = null) => new() { AbsoluteInstallRoot = root, InstallId = installId, Integration = integration, CrashHook = crash, ArtifactPipeline = (_, _, _) => { pipelineCalls++; return Task.FromResult(InstallArtifacts(root, bundle)); } };
        BootstrapOwnershipV1 ownership = await new BootstrapInstallerCore(Options()).InstallOrRecoverAsync(bundle);
        string installedLauncher = Path.Combine(root, "Launcher", "MagicPot.Launcher.exe"), installedUninstaller = Path.Combine(root, "Launcher", "MagicPot.Uninstall.exe");
        Need(File.ReadAllBytes(installedLauncher).SequenceEqual(fixture.LauncherBytes), "launcher bytes published"); Need(Hash(installedLauncher) == fixture.LauncherSha, "launcher hash published"); Need(File.ReadAllBytes(installedUninstaller).SequenceEqual(fixture.UninstallerBytes), "uninstaller bytes published"); Need(Hash(installedUninstaller) == fixture.UninstallerSha, "uninstaller hash published"); Need(Directory.Exists(Path.Combine(root, "apps", bundle.Selection.App.BuildId)), "app installed"); Need(Directory.Exists(Path.Combine(root, "runtimes", "runtime-1")), "runtime installed"); Need(File.Exists(Path.Combine(root, "active.json")), "active exists"); Need(File.Exists(Path.Combine(root, "launcher-health.json")), "health reset"); Need(File.Exists(Path.Combine(root, BootstrapInstallerCore.OwnershipFileName)), "ownership exists"); Need(!File.Exists(Path.Combine(root, BootstrapInstallerCore.JournalFileName)), "journal removed"); Need(integration.ApplyCalls == 1, "integration applied once"); Need(integration.VerifyCalls >= 1, "integration verified"); Need(ownership.InstallId == installId, "ownership install id"); Need(ownership.OperationId.Length == 32, "operation id"); Need(ownership.LauncherSha256 == fixture.LauncherSha, "ownership launcher hash"); Need(ownership.LauncherSize == fixture.LauncherBytes.Length, "ownership launcher size"); Need(ownership.LauncherVersion == "1.0.0", "ownership launcher version"); Need(ownership.UninstallerSha256 == fixture.UninstallerSha, "ownership uninstaller hash"); Need(ownership.UninstallerSize == fixture.UninstallerBytes.Length, "ownership uninstaller size"); Need(ownership.UninstallerVersion == "2.0.0", "ownership uninstaller version"); Need(ownership.Root == Path.GetFullPath(root), "ownership root"); Need(ownership.ActiveBuildId == bundle.Selection.App.BuildId, "ownership app"); Need(ownership.ActiveRuntimeId == "runtime-1", "ownership runtime"); Need(ownership.CreatedAt.EndsWith("Z", StringComparison.Ordinal), "ownership timestamp"); Need(pipelineCalls == 1, "pipeline once");
        BootstrapOwnershipV1 second = await new BootstrapInstallerCore(Options()).InstallOrRecoverAsync(bundle); Need(second == ownership, "owned install idempotent"); Need(pipelineCalls == 1, "owned install skips artifacts"); Need(integration.ApplyCalls == 1, "owned install skips apply");

        string conflictRoot = Path.Combine(temp, "nonempty"); Directory.CreateDirectory(conflictRoot); File.WriteAllText(Path.Combine(conflictRoot, "foreign.txt"), "x"); RejectAsync(() => new BootstrapInstallerCore(new BootstrapInstallerOptions { AbsoluteInstallRoot = conflictRoot, Integration = new FakeIntegration(), ArtifactPipeline = (_, _, _) => throw new InvalidOperationException() }).InstallOrRecoverAsync(bundle), "nonempty unowned");
        File.WriteAllBytes(installedLauncher, [9, 9, 9]); await RejectAsyncTask(() => new BootstrapInstallerCore(Options()).InstallOrRecoverAsync(bundle), "launcher tamper"); File.WriteAllBytes(installedLauncher, fixture.LauncherBytes);
        File.WriteAllBytes(installedUninstaller, [8, 8, 8]); await RejectAsyncTask(() => new BootstrapInstallerCore(Options()).InstallOrRecoverAsync(bundle), "uninstaller tamper"); File.WriteAllBytes(installedUninstaller, fixture.UninstallerBytes);

        foreach (string stage in new[] { "prepared", "stable-binaries-published", "artifacts-installed", "active-committed", "integration-applied", "after-ownership-write" })
        {
            string crashRoot = Path.Combine(temp, "crash-" + stage); string crashId = Guid.NewGuid().ToString("N"); var fake = new FakeIntegration(); bool crashed = false;
            BootstrapInstallerOptions CrashOptions(Action<string>? hook) => new() { AbsoluteInstallRoot = crashRoot, InstallId = crashId, Integration = fake, CrashHook = hook, ArtifactPipeline = (_, _, _) => Task.FromResult(InstallArtifacts(crashRoot, bundle)) };
            await RejectAsyncTask(() => new BootstrapInstallerCore(CrashOptions(point => { if (!crashed && point == stage) { crashed = true; throw new CrashException(); } })).InstallOrRecoverAsync(bundle), "crash " + stage, typeof(CrashException)); Need(File.Exists(Path.Combine(crashRoot, BootstrapInstallerCore.JournalFileName)), "journal retained " + stage);
            if (stage == "prepared")
            {
                using JsonDocument journal = JsonDocument.Parse(File.ReadAllText(Path.Combine(crashRoot, BootstrapInstallerCore.JournalFileName))); JsonElement state = journal.RootElement;
                string launcherPartial = Path.Combine(crashRoot, "Launcher", state.GetProperty("launcherTemporaryName").GetString()!); string uninstallerPartial = Path.Combine(crashRoot, "Launcher", state.GetProperty("uninstallerTemporaryName").GetString()!);
                File.WriteAllBytes(launcherPartial, fixture.LauncherBytes); File.WriteAllBytes(uninstallerPartial, fixture.UninstallerBytes[..(fixture.UninstallerBytes.Length / 2)]);
            }
            BootstrapOwnershipV1 recovered = await new BootstrapInstallerCore(CrashOptions(null)).InstallOrRecoverAsync(bundle); Need(recovered.InstallId == crashId, "recover install id " + stage); Need(!File.Exists(Path.Combine(crashRoot, BootstrapInstallerCore.JournalFileName)), "recover journal removed " + stage); Need(fake.ApplyCalls <= 1, "apply not repeated " + stage); Need(File.ReadAllBytes(Path.Combine(crashRoot, "Launcher", "MagicPot.Launcher.exe")).SequenceEqual(fixture.LauncherBytes), "recovered launcher " + stage); Need(File.ReadAllBytes(Path.Combine(crashRoot, "Launcher", "MagicPot.Uninstall.exe")).SequenceEqual(fixture.UninstallerBytes), "recovered uninstaller " + stage);
        }

        string applyCrashRoot = Path.Combine(temp, "apply-crash"); var applyCrashIntegration = new FakeIntegration(); bool applyCrash = false; BootstrapInstallerOptions ApplyCrashOptions(Action<string>? hook) => new() { AbsoluteInstallRoot = applyCrashRoot, Integration = applyCrashIntegration, CrashHook = hook, ArtifactPipeline = (_, _, _) => Task.FromResult(InstallArtifacts(applyCrashRoot, bundle)) };
        await RejectAsyncTask(() => new BootstrapInstallerCore(ApplyCrashOptions(point => { if (!applyCrash && point == "integration-apply-returned") { applyCrash = true; throw new CrashException(); } })).InstallOrRecoverAsync(bundle), "apply then crash", typeof(CrashException)); Need(applyCrashIntegration.ApplyCalls == 1, "apply completed before crash"); await new BootstrapInstallerCore(ApplyCrashOptions(null)).InstallOrRecoverAsync(bundle); Need(applyCrashIntegration.ApplyCalls == 1, "recovery does not repeat apply"); Need(applyCrashIntegration.VerifyCalls >= 1, "recovery verifies applied integration");

        string integrationConflictRoot = Path.Combine(temp, "integration-conflict"); var conflict = new FakeIntegration { ForcedState = InstallIntegrationState.Conflict }; await RejectAsyncTask(() => new BootstrapInstallerCore(new BootstrapInstallerOptions { AbsoluteInstallRoot = integrationConflictRoot, Integration = conflict, ArtifactPipeline = (_, _, _) => Task.FromResult(InstallArtifacts(integrationConflictRoot, bundle)) }).InstallOrRecoverAsync(bundle), "integration conflict"); Need(conflict.ApplyCalls == 0, "conflict fail closed");
    }

    private static void StateAndUninstall(string temp)
    {
        const string build = "20250101-010101-aaaaaaa";
        string root = Path.Combine(temp, "state-capability"); Directory.CreateDirectory(root); string id = Guid.NewGuid().ToString("N"), op = Guid.NewGuid().ToString("N"); Directory.CreateDirectory(Path.Combine(root, "Launcher")); File.WriteAllBytes(Path.Combine(root, "Launcher", "MagicPot.Launcher.exe"), [1, 2, 3]); File.WriteAllBytes(Path.Combine(root, "Launcher", "MagicPot.Uninstall.exe"), [4, 5, 6, 7]); Directory.CreateDirectory(Path.Combine(root, "apps", build)); Directory.CreateDirectory(Path.Combine(root, "runtimes", "runtime-1"));
        var ownership = new BootstrapOwnershipV1(1, op, id, Path.GetFullPath(root), new string('a', 64), 3, "1.0.0", new string('b', 64), 4, "2.0.0", build, "runtime-1", "2025-01-01T00:00:00.000Z", null); var store = new BootstrapSafeAtomicFileStore(root, [BootstrapInstallerCore.OwnershipFileName]); store.Write(Path.Combine(root, BootstrapInstallerCore.OwnershipFileName), ownership, text => JsonSerializer.Deserialize<BootstrapOwnershipV1>(text, new JsonSerializerOptions(JsonSerializerDefaults.Web))!);
        string launcher = Path.Combine(root, "Launcher", "MagicPot.Launcher.exe"), uninstaller = Path.Combine(root, "Launcher", "MagicPot.Uninstall.exe"), launcherMoved = launcher + ".moved", appDirectory = Path.Combine(root, "apps", build), appMoved = appDirectory + ".moved";
        using (var ownershipProbe = new FileStream(Path.Combine(root, BootstrapInstallerCore.OwnershipFileName), FileMode.Open, FileAccess.Read, FileShare.Read)) { Need(ownershipProbe.Length > 0, "ownership readable before capability"); }
        using UninstallCapability capability = UninstallCapabilityBuilder.Build(root, id, Path.Combine(temp, "user-data"));
        Need(capability.InstallId == id, "capability install id"); Need(capability.FixedPaths.Count == 13, "fixed owned paths"); Need(capability.FixedPaths.Contains(Path.Combine(root, "Launcher")), "stable binaries directory owned"); Need(capability.PreservedPaths.Count == 1, "user data preserved"); Need(capability.FixedPaths.All(p => Path.GetFullPath(p).StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)), "owned paths confined"); capability.ValidateStillOwned(); Need(true, "identity validation succeeds");
        SharingDenied(() => File.Delete(launcher), "held launcher delete denied"); SharingDenied(() => File.Move(launcher, launcherMoved), "held launcher rename denied"); SharingDenied(() => { using FileStream stream = File.OpenWrite(launcher); }, "held launcher write denied"); SharingDenied(() => File.Delete(uninstaller), "held uninstaller delete denied"); SharingDenied(() => { using FileStream stream = File.OpenWrite(uninstaller); }, "held uninstaller write denied"); SharingDenied(() => Directory.Move(appDirectory, appMoved), "held directory rename denied");
        SharingDenied(() => { File.Delete(launcher); File.WriteAllBytes(launcher, [1, 2, 3]); }, "same-byte replacement cannot occur"); capability.ValidateStillOwned(); Need(true, "blocked replacement preserves ownership");
        string extra = Path.Combine(appDirectory, "extra.txt"); File.WriteAllText(extra, "extra"); Reject(() => capability.ValidateStillOwned(), "capability rejects extra directory child"); File.Delete(extra); capability.ValidateStillOwned(); Need(true, "removing extra child restores exact tree");
        string outside = Path.Combine(temp, "outside-user-data"); Need(!capability.FixedPaths.Contains(outside), "outside not owned"); Need(capability.PreservedPaths.Single() != launcher, "preserved separate from launcher");
        string userData = Path.Combine(temp, "user-data"); Directory.CreateDirectory(userData); File.WriteAllText(Path.Combine(userData, "keep.txt"), "keep");
        capability.Execute(); Need(capability.Completed, "uninstall completed"); Need(!Directory.Exists(root), "uninstall deletes owned root"); Need(File.Exists(Path.Combine(userData, "keep.txt")), "external user data preserved"); RejectDisposed(() => capability.ValidateStillOwned(), "completed capability disposed");
    }

    private static BootstrapArtifactInstallResult InstallArtifacts(string root, VerifiedBootstrapBundle bundle)
    {
        SelectedArtifactsV1 selection = bundle.Selection;
        string appDirectory = Path.Combine(root, "apps", selection.App.BuildId);
        string runtimeDirectory = Path.Combine(root, "runtimes", selection.Runtime.RuntimeId);
        string appEntrypoint = Path.Combine(appDirectory, selection.App.Entrypoint);
        string pythonEntrypoint = Path.Combine(runtimeDirectory, selection.Runtime.Entrypoint);
        const string comfyuiEntrypoint = "ComfyUI/main.py";
        string comfyuiPath = Path.Combine(runtimeDirectory, "ComfyUI", "main.py");
        Directory.CreateDirectory(Path.GetDirectoryName(appEntrypoint)!);
        Directory.CreateDirectory(Path.GetDirectoryName(pythonEntrypoint)!);
        Directory.CreateDirectory(Path.GetDirectoryName(comfyuiPath)!);

        byte[] appBytes = Encoding.UTF8.GetBytes("dummy app entrypoint\n");
        byte[] pythonBytes = Encoding.UTF8.GetBytes("dummy runtime entrypoint\n");
        byte[] comfyuiBytes = Encoding.UTF8.GetBytes("# dummy ComfyUI entrypoint\n");
        File.WriteAllBytes(appEntrypoint, appBytes);
        File.WriteAllBytes(pythonEntrypoint, pythonBytes);
        File.WriteAllBytes(comfyuiPath, comfyuiBytes);

        static InstalledFileV1 InstalledFile(string path, byte[] bytes) =>
            new(path, bytes.LongLength, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());

        InstalledFileV1 appFile = InstalledFile(selection.App.Entrypoint, appBytes);
        var appManifest = new InstalledAppManifestV1(
            1, "magicpot-app", selection.Release.Version, selection.Release.BuildId, selection.Release.CommitSha,
            selection.App.Platform, selection.App.Arch, selection.App.RuntimeId, selection.App.Entrypoint,
            selection.App.CreatedAt, appFile.Size, [appFile]);
        File.WriteAllText(Path.Combine(appDirectory, "manifest.json"), Protocol.Serialize(appManifest));

        InstalledFileV1 pythonFile = InstalledFile(selection.Runtime.Entrypoint, pythonBytes);
        InstalledFileV1 comfyuiFile = InstalledFile(comfyuiEntrypoint, comfyuiBytes);
        var runtimeManifest = new InstalledRuntimeManifestV1(
            1, "magicpot-runtime", selection.Runtime.RuntimeId, selection.Runtime.Platform, selection.Runtime.Arch,
            selection.Runtime.CreatedAt, new RuntimeEntrypointsV1(selection.Runtime.Entrypoint, comfyuiEntrypoint),
            pythonFile.Size + comfyuiFile.Size, [pythonFile, comfyuiFile]);
        File.WriteAllText(Path.Combine(runtimeDirectory, "manifest.json"), Protocol.Serialize(runtimeManifest));
        return new BootstrapArtifactInstallResult(appDirectory, runtimeDirectory);
    }

    private static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
    private static void Need(bool condition, string message) { assertions++; if (!condition) throw new InvalidOperationException(message); }
    private static void SharingDenied(Action action, string message) { assertions++; try { action(); } catch (IOException) { return; } catch (UnauthorizedAccessException) { return; } throw new InvalidOperationException("Accepted " + message); }
    private static void RejectDisposed(Action action, string message) { assertions++; try { action(); } catch (ObjectDisposedException) { return; } throw new InvalidOperationException("Accepted " + message); }
    private static void Reject(Action action, string message) { assertions++; try { action(); } catch (Exception e) when (e is BootstrapInstallerException or ArgumentException or LocalSmokeActivationException or PreparedArtifactInstallationException) { return; } throw new InvalidOperationException("Accepted " + message); }
    private static void RejectAsync(Func<Task> action, string message) => RejectAsyncTask(action, message).GetAwaiter().GetResult();
    private static async Task RejectAsyncTask(Func<Task> action, string message, Type? exact = null) { assertions++; try { await action(); } catch (Exception e) { if (exact is null && e is BootstrapInstallerException or LocalSmokeActivationException or PreparedArtifactInstallationException || exact is not null && e.GetType() == exact) return; throw; } throw new InvalidOperationException("Accepted " + message); }

    private sealed class CrashException : Exception { }
    private sealed class FakeIntegration : IInstallIntegration
    {
        internal int ApplyCalls, VerifyCalls, RollbackCalls; internal InstallIntegrationState? ForcedState; private string? operation;
        public InstallIntegrationState Inspect(string operationId, BootstrapOwnershipV1 ownership) => ForcedState ?? (operation is null ? InstallIntegrationState.Missing : operation == operationId ? InstallIntegrationState.Applied : InstallIntegrationState.Conflict);
        public void Apply(string operationId, BootstrapOwnershipV1 ownership, string launcherExe) { ApplyCalls++; operation = operationId; }
        public void Verify(string operationId, BootstrapOwnershipV1 ownership, string launcherExe) { VerifyCalls++; if (operation != operationId) throw new BootstrapInstallerException("fake integration missing"); }
        public void Rollback(string operationId, BootstrapOwnershipV1 ownership, string launcherExe) { RollbackCalls++; if (operation == operationId) operation = null; }
    }

    private sealed record Fixture(byte[] DescriptorBytes, byte[] DescriptorSignature, string LauncherPath, byte[] LauncherBytes, string LauncherSha, string UninstallerPath, byte[] UninstallerBytes, string UninstallerSha, string Manifest, string Build, Ed25519PrivateKeyParameters DescriptorPrivate)
    {
        internal static Fixture Create(string temp)
        {
            byte[] launcher = Encoding.UTF8.GetBytes("local launcher payload\n"), uninstaller = Encoding.UTF8.GetBytes("different local uninstaller payload\n");
            string launcherPath = Path.Combine(temp, "MagicPot.Launcher.exe"), uninstallerPath = Path.Combine(temp, "MagicPot.Uninstall.exe"); File.WriteAllBytes(launcherPath, launcher); File.WriteAllBytes(uninstallerPath, uninstaller);
            string launcherSha = Convert.ToHexString(SHA256.HashData(launcher)).ToLowerInvariant(), uninstallerSha = Convert.ToHexString(SHA256.HashData(uninstaller)).ToLowerInvariant();
            Ed25519PrivateKeyParameters manifestPrivate = Private(11);
            string commit = new string('a', 40), build = "20250101-000000-" + new string('a', 7);
            string unsignedManifest = "{\"schema\":1,\"channel\":\"stable\",\"generatedAt\":\"2025-01-01T00:00:00.000Z\",\"releases\":[{\"version\":\"1.0.0\",\"buildId\":\"" + build + "\",\"commitSha\":\"" + commit + "\",\"publishedAt\":\"2025-01-01T00:00:00.000Z\",\"releaseNotesUrl\":\"https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/tag/v1\",\"minimumLauncherVersion\":\"1.0.0\",\"artifacts\":{\"app\":{\"kind\":\"app\",\"version\":\"1.0.0\",\"buildId\":\"" + build + "\",\"commitSha\":\"" + commit + "\",\"runtimeId\":\"runtime-1\",\"platform\":\"win32\",\"arch\":\"x64\",\"url\":\"https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/download/v1/app.zip\",\"sha256\":\"" + new string('b', 64) + "\",\"size\":10,\"unpackedSize\":20,\"entrypoint\":\"app.exe\",\"createdAt\":\"2025-01-01T00:00:00.000Z\"},\"runtime\":{\"kind\":\"runtime\",\"runtimeId\":\"runtime-1\",\"platform\":\"win32\",\"arch\":\"x64\",\"url\":\"https://github.com/MagicPotTeam/MagicPot-Terrarium-Releases/releases/download/v1/runtime.zip\",\"sha256\":\"" + new string('c', 64) + "\",\"size\":10,\"unpackedSize\":20,\"entrypoint\":\"runtime.exe\",\"createdAt\":\"2025-01-01T00:00:00.000Z\"}}}],\"signature\":{\"algorithm\":\"ed25519\",\"keyId\":\"manifest\",\"value\":\"" + Convert.ToBase64String(new byte[64]) + "\"}}";
            ChannelManifestV1 parsed = OfflineUpdateDecision.ParseChannelManifest(unsignedManifest, "stable"); byte[] manifestSignature = Sign(manifestPrivate, OfflineUpdateDecision.SigningPayload(parsed)); string manifest = unsignedManifest.Replace(Convert.ToBase64String(new byte[64]), Convert.ToBase64String(manifestSignature), StringComparison.Ordinal);
            Ed25519PrivateKeyParameters descriptorPrivate = Private(29);
            var fixture = new Fixture([], [], Path.GetFullPath(launcherPath), launcher, launcherSha, Path.GetFullPath(uninstallerPath), uninstaller, uninstallerSha, manifest, build, descriptorPrivate);
            byte[] descriptor = fixture.CreateDescriptor(uninstallerSha); return fixture with { DescriptorBytes = descriptor, DescriptorSignature = fixture.SignDescriptor(descriptor) };
        }
        internal byte[] CreateDescriptor(string uninstallerSha) => JsonSerializer.SerializeToUtf8Bytes(new { schema = 1, signature = new { algorithm = "ed25519", keyId = "descriptor" }, launcherVersion = "1.0.0", launcher = new { sourcePath = "MagicPot.Launcher.exe", sha256 = LauncherSha, size = LauncherBytes.LongLength }, uninstaller = new { version = "2.0.0", sourcePath = "MagicPot.Uninstall.exe", size = UninstallerBytes.LongLength, sha256 = uninstallerSha }, channelManifestRaw = Manifest, selection = new { channel = "stable", buildId = Build, runtimeId = "runtime-1" } });
        internal byte[] SignDescriptor(byte[] payload) => Sign(DescriptorPrivate, payload);
        private static Ed25519PrivateKeyParameters Private(byte seedByte) => new(Enumerable.Repeat(seedByte, 32).ToArray(), 0);
        private static byte[] Sign(Ed25519PrivateKeyParameters key, byte[] payload) { var signer = new Ed25519Signer(); signer.Init(true, key); signer.BlockUpdate(payload, 0, payload.Length); return signer.GenerateSignature(); }
    }
}
