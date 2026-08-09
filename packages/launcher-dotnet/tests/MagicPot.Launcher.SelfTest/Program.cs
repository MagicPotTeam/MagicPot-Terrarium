using System.Security.Cryptography;

using System.Diagnostics;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.Json;
using MagicPot.Launcher;

static void Assert(bool condition, string message) { if (!condition) throw new Exception(message); }
static string Sha(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
static InstalledFileV1 InstalledFile(string path, byte[] content) => new(path, content.LongLength, Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant());
static void ExpectSharingDenied(Action action, string message)
{
    try { action(); throw new Exception(message); }
    catch (IOException) { }
    catch (UnauthorizedAccessException) { }
}

var build = "20250101-010203-abcdef0";
var runtime = "runtime-1";
var app = new InstalledAppManifestV1(1, "magicpot-app", "1.0.0", build, "abcdef0123456789abcdef0123456789abcdef01", "win32", "x64", runtime, "MagicPot.EXE", "2025-01-01T01:02:03.000Z", 1, null);
var rt = new InstalledRuntimeManifestV1(1, "magicpot-runtime", runtime, "win32", "x64", "2025-01-01T01:02:03.000Z", new("python.exe", "main.py"), 1, null);
var temp = Path.Combine(Path.GetTempPath(), "magicpot-launcher-selftest-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(temp);
try
{
    var exe = Path.Combine(temp, "MagicPot.EXE"); File.WriteAllText(exe, "x");
    var install = new ValidatedInstallation(app, rt, temp, temp, exe, LauncherEngine.CaptureFileIdentity(exe));
    var psi = LauncherEngine.BuildProcessStartInfo(install, ["--test"], "token", temp);
    foreach (var name in new[] { "MAGICPOT_LAUNCH_BUILD_ID", "MAGICPOT_ACTIVE_BUILD_ID", "MAGICPOT_ACTIVE_BUILD" }) Assert(psi.Environment[name] == build, name);
    foreach (var name in new[] { "MAGICPOT_LAUNCH_RUNTIME_ID", "MAGICPOT_ACTIVE_RUNTIME_ID", "MAGICPOT_ACTIVE_RUNTIME" }) Assert(psi.Environment[name] == runtime, name);
    Assert(psi.Environment["MAGICPOT_LAUNCH_TOKEN"] == "token" && psi.Environment["MAGICPOT_LAUNCHER_ROOT"] == temp, "bridge environment");
    Assert(psi.Environment["MAGICPOT_RUNTIME_DIR"] == temp, "detached runtime directory environment");
    Environment.SetEnvironmentVariable("MAGICPOT_UPDATE_UNTRUSTED", "parent");
    var updatePsi = LauncherEngine.BuildProcessStartInfo(install, [], "token", temp, new("notify-on-launch", "available", "beta", "2.0.0"));
    Environment.SetEnvironmentVariable("MAGICPOT_UPDATE_UNTRUSTED", null);
    Assert(!updatePsi.Environment.ContainsKey("MAGICPOT_UPDATE_UNTRUSTED"), "parent update environment cleared");
    Assert(updatePsi.Environment["MAGICPOT_UPDATE_MODE"] == "notify-on-launch" && updatePsi.Environment["MAGICPOT_UPDATE_STATUS"] == "available" && updatePsi.Environment["MAGICPOT_UPDATE_CHANNEL"] == "beta" && updatePsi.Environment["MAGICPOT_UPDATE_VERSION"] == "2.0.0", "update environment");
    Assert(LauncherSettingsStore.Default == new LauncherSettingsV1(1, "manual", "stable", 3, 3, false), "settings defaults");

    var pending = new PendingLauncherHealthV1(build, runtime, "token", 1, "2025-01-01T01:02:03.000Z", "2025-01-01T01:03:03.000Z");
    var matchingReceipt = new LauncherHealthConfirmationV1(build, runtime, "token", "2025-01-01T01:02:30.000Z");
    Assert(LauncherEngine.IsAcceptedHealthTransition(new(1, 0, null, matchingReceipt), pending), "matching receipt accepted");
    Assert(!LauncherEngine.IsAcceptedHealthTransition(new(1, 0), pending), "missing receipt rejected");
    Assert(!LauncherEngine.IsAcceptedHealthTransition(new(1, 0, null, matchingReceipt with { LaunchToken = "other" }), pending), "mismatched receipt rejected");
    Assert(!LauncherEngine.IsAcceptedHealthTransition(new(1, 0, null, matchingReceipt with { ConfirmedAt = "2025-01-01T01:02:02.999Z" }), pending), "pre-start receipt rejected");
    Assert(LauncherEngine.IsAcceptedHealthTransition(new(1, 0, null, matchingReceipt with { ConfirmedAt = pending.StartedAt }), pending), "startedAt-equal receipt accepted");
    Assert(!LauncherEngine.IsAcceptedHealthTransition(new(1, 0, null, matchingReceipt with { ConfirmedAt = "2025-01-01T01:03:03.000Z" }), pending), "deadline-equal receipt rejected");
    Assert(!LauncherEngine.IsAcceptedHealthTransition(new(1, 0, null, matchingReceipt with { ConfirmedAt = "2025-01-01T01:03:04.000Z" }), pending), "late receipt rejected");
    Assert(!LauncherEngine.IsAcceptedHealthTransition(new(1, 1, null, matchingReceipt), pending), "failure state rejected");

    var lockPath = Path.Combine(temp, ".health-lock"); var lockFile = Path.Combine(lockPath, "update.lock");
    using (UpdateFileLock.Acquire(lockPath))
    {
        Assert(Directory.Exists(lockPath) && File.Exists(lockFile), "permanent health lock container with update.lock");
        using var ownerStream = new FileStream(lockFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var owner = JsonDocument.Parse(ownerStream);
        var fields = owner.RootElement.EnumerateObject().Select(x => x.Name).Order().ToArray();
        Assert(fields.SequenceEqual(new[] { "createdAt", "hostname", "pid", "schema", "token" }), "owner schema");
        Assert(owner.RootElement.GetProperty("schema").GetInt32() == 1, "owner schema version");
        using (var nodeReader = new FileStream(lockFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            Assert(nodeReader.Length > 0, "FileShare.Read permits Node owner read");
        try { using var writer = new FileStream(lockFile, FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete); throw new Exception("lock permitted writing"); } catch (IOException) { }
        try { File.Delete(lockFile); throw new Exception("lock permitted deletion"); } catch (IOException) { }
        try { using var competing = UpdateFileLock.Acquire(lockPath, TimeSpan.Zero); throw new Exception("lock was not exclusive"); } catch (TimeoutException) { }
    }
    Assert(Directory.Exists(lockPath) && !File.Exists(lockFile), "release removes only update.lock");

    Assert(UpdateFileLock.HealthLockStale == TimeSpan.FromMinutes(10), "shared health lock stale configuration");
    var camel = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    File.WriteAllText(lockFile, JsonSerializer.Serialize(new UpdateLockOwnerV1(1, "active", Environment.ProcessId, Dns.GetHostName(), "2000-01-01T00:00:00.000Z"), camel));
    try { using var activeLock = UpdateFileLock.Acquire(lockPath, TimeSpan.Zero, stale: TimeSpan.Zero); throw new Exception("active pid lock was reaped"); } catch (TimeoutException) { }
    Assert(File.Exists(lockFile), "active pid stale lock retained");
    File.WriteAllText(lockFile, JsonSerializer.Serialize(new UpdateLockOwnerV1(1, "dead", int.MaxValue, Dns.GetHostName().ToUpperInvariant(), "2000-01-01T00:00:00.000Z"), camel));
    using (UpdateFileLock.Acquire(lockPath, TimeSpan.FromSeconds(1), stale: TimeSpan.Zero)) { Assert(File.Exists(lockFile), "case-insensitive local dead stale lock recovered"); }
    var remoteHostname = Dns.GetHostName() + "-remote";
    File.WriteAllText(lockFile, JsonSerializer.Serialize(new UpdateLockOwnerV1(1, "remote", int.MaxValue, remoteHostname, "2000-01-01T00:00:00.000Z"), camel));
    try { using var remote = UpdateFileLock.Acquire(lockPath, TimeSpan.Zero, stale: TimeSpan.Zero); throw new Exception("remote host lock was reaped"); } catch (TimeoutException) { }
    Assert(File.Exists(lockFile), "remote host stale lock retained");

    foreach (var invalidOwner in new[]
    {
        "{\"schema\":1,\"token\":\"bad\",\"pid\":1,\"hostname\":\"host\",\"createdAt\":\"2025-01-01T01:02:03.000+00:00\"}",
        "{\"schema\":1,\"token\":\"bad\",\"pid\":1,\"hostname\":\"host\",\"createdAt\":\"2025-01-01T01:02:03Z\"}",
        "{\"schema\":1,\"token\":\"bad\",\"pid\":1,\"hostname\":\"host\",\"createdAt\":\"2025-01-01T01:02:03.000Z\",\"actor\":\"extra\"}",
        "{\"schema\":1,\"token\":\"\",\"pid\":1,\"hostname\":\"host\",\"createdAt\":\"2025-01-01T01:02:03.000Z\"}",
        "{\"schema\":1,\"token\":\"bad\",\"pid\":0,\"hostname\":\"host\",\"createdAt\":\"2025-01-01T01:02:03.000Z\"}",
        "{\"schema\":1,\"token\":\"bad\",\"pid\":2147483648,\"hostname\":\"host\",\"createdAt\":\"2025-01-01T01:02:03.000Z\"}",
        "{\"schema\":1,\"token\":\"bad\",\"pid\":1,\"hostname\":\"\",\"createdAt\":\"2025-01-01T01:02:03.000Z\"}"
    })
    {
        File.WriteAllText(lockFile, invalidOwner);
        try { using var invalid = UpdateFileLock.Acquire(lockPath, TimeSpan.Zero, stale: TimeSpan.Zero); throw new Exception("invalid owner was reaped"); } catch (TimeoutException) { }
        Assert(File.Exists(lockFile), "invalid owner retained");
    }
    File.Delete(lockFile);

    var foreign = UpdateFileLock.Acquire(lockPath);
    var lockHandle = (FileStream)typeof(UpdateFileLock).GetField("handle", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(foreign)!;
    lockHandle.Dispose();
    var foreignOwner = JsonSerializer.Deserialize<UpdateLockOwnerV1>(File.ReadAllText(lockFile, Encoding.UTF8), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
    File.WriteAllText(lockFile, JsonSerializer.Serialize(foreignOwner with { Token = "foreign" }, camel));
    try { foreign.Dispose(); throw new Exception("foreign token release accepted"); } catch (IOException) { }
    Assert(File.Exists(lockFile), "foreign token was not deleted");
    File.Delete(lockFile);

    var before = LauncherEngine.CaptureFileIdentity(exe); var stamp = File.GetLastWriteTimeUtc(exe);
    var replacement = Path.Combine(temp, "replacement.exe"); File.WriteAllText(replacement, "y"); File.SetLastWriteTimeUtc(replacement, stamp);
    File.Move(replacement, exe, true);
    Assert(!LauncherEngine.SameFileIdentity(before, LauncherEngine.CaptureFileIdentity(exe)), "same length and mtime replacement rejected");

    var listedManifest = $$"""{"schema":1,"kind":"magicpot-app","version":"1.0.0","buildId":"{{build}}","commitSha":"abcdef0123456789abcdef0123456789abcdef01","platform":"win32","arch":"x64","runtimeId":"{{runtime}}","entrypoint":"MagicPot.EXE","createdAt":"2025-01-01T01:02:03.000Z","unpackedSize":1,"files":[{"path":"MANIFEST.JSON","size":1,"sha256":"{{Sha("x")}}"}]}""";
    try { Protocol.ParseAppManifest(listedManifest); throw new Exception("case-insensitive manifest exclusion not enforced"); } catch (ProtocolException) { }

    var layout = LauncherLayout.Create(temp);
    Directory.CreateDirectory(layout.Apps); Directory.CreateDirectory(layout.Runtimes);

    var installedBuild = "20250102-030405-abcdef0";
    var installedRuntime = "runtime-lease-1";
    var appDirectory = Path.Combine(layout.Apps, installedBuild);
    var runtimeDirectory = Path.Combine(layout.Runtimes, installedRuntime);
    Directory.CreateDirectory(appDirectory); Directory.CreateDirectory(runtimeDirectory);
    var appBytes = Encoding.UTF8.GetBytes("APP0");
    var pythonBytes = Encoding.UTF8.GetBytes("PY00");
    var comfyBytes = Encoding.UTF8.GetBytes("print('ok')\n");
    var appFile = InstalledFile("MagicPot.exe", appBytes);
    var pythonFile = InstalledFile("python.exe", pythonBytes);
    var comfyFile = InstalledFile("main.py", comfyBytes);
    var installedApp = new InstalledAppManifestV1(1, "magicpot-app", "1.0.0", installedBuild, "abcdef0123456789abcdef0123456789abcdef01", "win32", "x64", installedRuntime, appFile.Path, "2025-01-02T03:04:05.000Z", appFile.Size, [appFile]);
    var installedRt = new InstalledRuntimeManifestV1(1, "magicpot-runtime", installedRuntime, "win32", "x64", "2025-01-02T03:04:05.000Z", new(pythonFile.Path, comfyFile.Path), pythonFile.Size + comfyFile.Size, [pythonFile, comfyFile]);
    var appPath = Path.Combine(appDirectory, appFile.Path);
    var pythonPath = Path.Combine(runtimeDirectory, pythonFile.Path);
    File.WriteAllBytes(appPath, appBytes); File.WriteAllBytes(pythonPath, pythonBytes); File.WriteAllBytes(Path.Combine(runtimeDirectory, comfyFile.Path), comfyBytes);
    File.WriteAllText(Path.Combine(appDirectory, "manifest.json"), Protocol.Serialize(installedApp), new UTF8Encoding(false));
    File.WriteAllText(Path.Combine(runtimeDirectory, "manifest.json"), Protocol.Serialize(installedRt), new UTF8Encoding(false));
    var active = new ActivePointerV1(1, installedBuild, installedRuntime, null, null, "2025-01-02T03:04:05.000Z");
    File.WriteAllText(layout.ActivePointer, Protocol.Serialize(active), new UTF8Encoding(false));
    var selection = new InstalledSelectionResolver(layout).ResolveActive();
    Assert(selection is not null, "safe resolver selected valid installed manifests");

    var starterMethods = typeof(DirectInstalledProcessStarter).GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly).Where(method => method.Name == "Start").ToArray();
    Assert(starterMethods.Length == 1 && starterMethods[0].GetParameters().Select(parameter => parameter.ParameterType).SequenceEqual([typeof(InstalledLaunchLease), typeof(System.Diagnostics.ProcessStartInfo)]), "direct starter accepts only lease and ProcessStartInfo");
    var environmentInfo = new ProcessStartInfo(appPath) { UseShellExecute = false, WorkingDirectory = appDirectory };
    environmentInfo.Environment["MAGICPOT_ENV_BLOCK_TEST"] = "unicode-环境";
    string environmentBlock = DirectInstalledProcessStarter.BuildEnvironmentBlock(environmentInfo);
    Assert(environmentBlock.EndsWith("\0\0", StringComparison.Ordinal) && !environmentBlock.EndsWith("\0\0\0", StringComparison.Ordinal), "direct starter emits an exact double-NUL environment terminator");
    Assert(environmentBlock.Contains("MAGICPOT_ENV_BLOCK_TEST=unicode-环境\0", StringComparison.Ordinal), "direct starter preserves Unicode environment values");
    Assert(environmentInfo.Environment["PATH"]!.Split(';').All(path => Path.IsPathFullyQualified(path) && !path.Contains("dotnet", StringComparison.OrdinalIgnoreCase)), "direct starter restricts PATH to system directories");
    WindowsDllSearchHardening.EnsureInitialized(); WindowsDllSearchHardening.EnsureInitialized();
    Assert(WindowsDllSearchHardening.IsInitialized, "DLL search hardening is repeatably initialized");

    var appMoved = appPath + ".moved";
    var runtimeMoved = runtimeDirectory + ".moved";
    var appsMoved = layout.Apps + ".moved";
    var runtimesMoved = layout.Runtimes + ".moved";
    var extra = Path.Combine(appDirectory, "extra.bin");
    using (var lease = InstalledLaunchLease.Acquire(layout, selection!))
    {
        foreach (var pinned in new[] { appPath, pythonPath })
        {
            byte[] replacementBytes = Enumerable.Repeat((byte)'Z', checked((int)new FileInfo(pinned).Length)).ToArray();
            ExpectSharingDenied(() => File.WriteAllBytes(pinned, replacementBytes), "lease permitted equal-length File.WriteAllBytes: " + pinned);
            ExpectSharingDenied(() => { using var stream = File.OpenWrite(pinned); }, "lease permitted File.OpenWrite: " + pinned);
            ExpectSharingDenied(() => File.Delete(pinned), "lease permitted File.Delete: " + pinned);
            ExpectSharingDenied(() => File.Move(pinned, pinned + ".moved"), "lease permitted File.Move: " + pinned);
            using var reader = File.OpenRead(pinned); Assert(reader.Length == replacementBytes.Length, "lease permits File.OpenRead");
        }
        ExpectSharingDenied(() => Directory.Move(appDirectory, appDirectory + ".moved"), "lease permitted app final rename");
        ExpectSharingDenied(() => Directory.Move(runtimeDirectory, runtimeMoved), "lease permitted runtime final rename");
        ExpectSharingDenied(() => Directory.Move(layout.Apps, appsMoved), "lease permitted apps ancestor rename");
        ExpectSharingDenied(() => Directory.Move(layout.Runtimes, runtimesMoved), "lease permitted runtimes ancestor rename");
        File.WriteAllText(extra, "allowed while pinned");
        try { lease.ValidateImmediatelyBeforeLaunch(); throw new Exception("extra file passed pre-launch validation"); } catch (PreparedArtifactInstallationException) { }
        File.Delete(extra);
        lease.ValidateImmediatelyBeforeLaunch();
    }
    File.WriteAllBytes(appPath, Encoding.UTF8.GetBytes("APP1"));
    File.Move(appPath, appMoved); File.Move(appMoved, appPath);
    File.WriteAllBytes(appPath, appBytes);
    Assert(File.ReadAllBytes(appPath).SequenceEqual(appBytes), "post-dispose app mutation and rename restored");

    var emptyApp = installedApp with { Files = [], UnpackedSize = 1 };
    var emptyInstall = selection!.Installation with { App = emptyApp };
    try { using var rejected = InstalledLaunchLease.Acquire(layout, new InstalledSelection(active, emptyInstall)); throw new Exception("empty files manifest acquired lease"); } catch (IOException) { }

    var emptyLayout = LauncherLayout.Create(Path.Combine(temp, "empty-layout"));
    Directory.CreateDirectory(emptyLayout.Apps); Directory.CreateDirectory(emptyLayout.Runtimes);
    File.WriteAllText(emptyLayout.Log, "locked");
    File.SetAttributes(emptyLayout.Log, FileAttributes.ReadOnly);
    var engine = new LauncherEngine(emptyLayout);
    try { engine.Select(); throw new Exception("expected primary selection error"); }
    catch (InvalidOperationException error) { Assert(error.Message.Contains("No valid installed", StringComparison.Ordinal), "logging masked primary error"); }
    finally { File.SetAttributes(emptyLayout.Log, FileAttributes.Normal); }
}
finally { try { Directory.Delete(temp, true); } catch { } }
Console.WriteLine("MagicPot.Launcher self-test passed");
