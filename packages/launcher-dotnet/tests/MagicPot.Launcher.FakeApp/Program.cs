using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading;

return Run(args);

static int Run(string[] args)
{
    if (args.Contains("--grandchild-worker", StringComparer.Ordinal))
    {
        WritePid("MAGICPOT_TEST_GRANDCHILD_PID_PATH");
        Thread.Sleep(TimeSpan.FromSeconds(30));
        return 0;
    }
    if (args.Contains("--child-holds-pipe-worker", StringComparer.Ordinal))
    {
        WritePid("MAGICPOT_TEST_CHILD_PID_PATH");
        string ping = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "ping.exe");
        var grandchildStart = new ProcessStartInfo(ping) { UseShellExecute = false, CreateNoWindow = true };
        grandchildStart.ArgumentList.Add("-n");
        grandchildStart.ArgumentList.Add("31");
        grandchildStart.ArgumentList.Add("127.0.0.1");
        using Process grandchild = Process.Start(grandchildStart) ?? throw new InvalidOperationException("Grandchild did not start");
        string? grandchildPidPath = Environment.GetEnvironmentVariable("MAGICPOT_TEST_GRANDCHILD_PID_PATH");
        if (!string.IsNullOrWhiteSpace(grandchildPidPath) && Path.IsPathFullyQualified(grandchildPidPath)) File.WriteAllText(grandchildPidPath, grandchild.Id.ToString(CultureInfo.InvariantCulture));
        Thread.Sleep(TimeSpan.FromSeconds(30));
        return 0;
    }
    if (args.Contains("--update-smoke-test", StringComparer.Ordinal)) return RunSmoke();
    var mode = args.Length == 0 ? "healthy" : args[0];
    string? rootPidPath = Environment.GetEnvironmentVariable("MAGICPOT_TEST_ROOT_PID_PATH");
    if (!string.IsNullOrWhiteSpace(rootPidPath) && Path.IsPathFullyQualified(rootPidPath)) File.WriteAllText(rootPidPath, Environment.ProcessId.ToString(CultureInfo.InvariantCulture));
    if (mode == "early-exit") return 23;
    if (mode == "no-confirm") { Thread.Sleep(TimeSpan.FromSeconds(10)); return 0; }
    if (mode == "no-confirm-child") { StartSleepingChild(); Thread.Sleep(TimeSpan.FromSeconds(30)); return 0; }
    if (mode != "healthy" && mode != "hang-with-child" && mode != "spawn-child-exit-root") return 64;

    var root = Required("MAGICPOT_LAUNCHER_ROOT");
    var buildId = Required("MAGICPOT_LAUNCH_BUILD_ID");
    var runtimeId = Required("MAGICPOT_LAUNCH_RUNTIME_ID");
    var launchToken = Required("MAGICPOT_LAUNCH_TOKEN");
    var capturePath = Environment.GetEnvironmentVariable("MAGICPOT_TEST_ENV_CAPTURE");
    if (!string.IsNullOrWhiteSpace(capturePath) && Path.IsPathFullyQualified(capturePath)) WriteCapture(capturePath, buildId, runtimeId);
    var lockRoot = Path.Combine(root, ".health-lock");
    Directory.CreateDirectory(lockRoot);
    using (var updateLock = Acquire(lockRoot))
    {
        var healthPath = Path.Combine(root, "launcher-health.json");
        using var document = JsonDocument.Parse(File.ReadAllText(healthPath));
        var pending = document.RootElement.GetProperty("pending");
        Require(pending.GetProperty("buildId").GetString() == buildId, "pending build does not match environment");
        Require(pending.GetProperty("runtimeId").GetString() == runtimeId, "pending runtime does not match environment");
        Require(pending.GetProperty("launchToken").GetString() == launchToken, "pending token does not match environment");
        var confirmedAt = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
        AtomicWrite(healthPath, new { schema = 1, failedAttemptCount = 0, lastHealthy = new { buildId, runtimeId, launchToken, confirmedAt } });
    }
    if (!string.IsNullOrWhiteSpace(capturePath) && Path.IsPathFullyQualified(capturePath)) WriteCapture(capturePath, buildId, runtimeId);
    if (mode == "hang-with-child" || mode == "spawn-child-exit-root") StartSleepingChild();
    string? readyMarker = Environment.GetEnvironmentVariable("MAGICPOT_TEST_READY_MARKER");
    if (!string.IsNullOrWhiteSpace(readyMarker) && Path.IsPathFullyQualified(readyMarker)) File.WriteAllText(readyMarker, Environment.ProcessId.ToString(CultureInfo.InvariantCulture));
    string? releaseMarker = Environment.GetEnvironmentVariable("MAGICPOT_TEST_RELEASE_MARKER");
    if (!string.IsNullOrWhiteSpace(releaseMarker) && Path.IsPathFullyQualified(releaseMarker))
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(30);
        while (!File.Exists(releaseMarker) && DateTime.UtcNow < deadline) Thread.Sleep(25);
    }
    else Thread.Sleep(TimeSpan.FromSeconds(2));
    return 0;
}

static void StartSleepingChild()
{
    string dotnet = Environment.ProcessPath ?? throw new InvalidOperationException("Process path unavailable");
    string assembly = System.Reflection.Assembly.GetEntryAssembly()?.Location ?? throw new InvalidOperationException("Entry assembly unavailable");
    string runtimeConfig = Path.Combine(Path.GetDirectoryName(assembly)!, "FakeApp.runtimeconfig.json");
    var start = new ProcessStartInfo(dotnet) { UseShellExecute = false, CreateNoWindow = true };
    start.ArgumentList.Add("exec");
    start.ArgumentList.Add("--runtimeconfig");
    start.ArgumentList.Add(runtimeConfig);
    start.ArgumentList.Add(assembly);
    start.ArgumentList.Add("--child-holds-pipe-worker");
    using Process child = Process.Start(start) ?? throw new InvalidOperationException("Sleeping child did not start");
    string? pidPath = Environment.GetEnvironmentVariable("MAGICPOT_TEST_CHILD_PID_PATH");
    if (!string.IsNullOrWhiteSpace(pidPath) && Path.IsPathFullyQualified(pidPath)) File.WriteAllText(pidPath, child.Id.ToString(CultureInfo.InvariantCulture));
}

static int RunSmoke()
{
    string mode = Environment.GetEnvironmentVariable("MAGICPOT_TEST_SMOKE_MODE") ?? "success";
    if (mode == "hang") { Thread.Sleep(TimeSpan.FromMinutes(5)); return 0; }
    if (mode == "child-holds-pipe")
    {
        string dotnet = Environment.ProcessPath ?? throw new InvalidOperationException("Process path unavailable");
        string assembly = System.Reflection.Assembly.GetEntryAssembly()?.Location ?? throw new InvalidOperationException("Entry assembly unavailable");
        string runtimeConfig = Path.Combine(Path.GetDirectoryName(assembly)!, "FakeApp.runtimeconfig.json");
        var start = new ProcessStartInfo(dotnet) { UseShellExecute = false, CreateNoWindow = true };
        start.ArgumentList.Add("exec");
        start.ArgumentList.Add("--runtimeconfig");
        start.ArgumentList.Add(runtimeConfig);
        start.ArgumentList.Add(assembly);
        start.ArgumentList.Add("--child-holds-pipe-worker");
        using Process child = Process.Start(start) ?? throw new InvalidOperationException("Pipe-holding child did not start");
        Thread.Sleep(TimeSpan.FromMinutes(5));
        return 0;
    }
    if (mode == "nonzero") return 23;
    if (mode == "malformed") { Console.WriteLine("not-json"); return 0; }
    if (mode == "oversize")
    {
        Console.Out.Write(new string('x', 1024 * 1024 + 4096));
        Console.Out.Flush();
    }
    if (mode == "stderr-oversize")
    {
        Console.Error.Write(new string('e', 1024 * 1024 + 4096));
        Console.Error.Flush();
    }
    if (mode == "invalid-utf8")
    {
        Stream output = Console.OpenStandardOutput();
        output.Write([0xC3, 0x28]);
        output.Flush();
        return 0;
    }
    if (mode == "extra-output") Console.WriteLine("fake app diagnostic");
    string buildId = Required("MAGICPOT_ACTIVE_BUILD_ID");
    string version = Environment.GetEnvironmentVariable("MAGICPOT_TEST_SMOKE_VERSION") ?? Environment.GetEnvironmentVariable("MAGICPOT_ACTIVE_VERSION") ?? "1.0.0";
    if (mode == "mismatch") buildId = "20250102-030406-0123456";
    Console.WriteLine(JsonSerializer.Serialize(new { ok = true, version, buildId }));
    return 0;
}

static void WriteCapture(string path, string buildId, string runtimeId)
{
    AtomicWrite(path, new
    {
        updateMode = Environment.GetEnvironmentVariable("MAGICPOT_UPDATE_MODE"),
        status = Environment.GetEnvironmentVariable("MAGICPOT_UPDATE_STATUS"),
        channel = Environment.GetEnvironmentVariable("MAGICPOT_UPDATE_CHANNEL"),
        version = Environment.GetEnvironmentVariable("MAGICPOT_UPDATE_VERSION"),
        launch = new { build = buildId, runtime = runtimeId }
    });
}

static void WritePid(string variable)
{
    string? path = Environment.GetEnvironmentVariable(variable);
    if (!string.IsNullOrWhiteSpace(path) && Path.IsPathFullyQualified(path)) File.WriteAllText(path, Environment.ProcessId.ToString(CultureInfo.InvariantCulture));
}

static string Required(string name) => Environment.GetEnvironmentVariable(name) ?? throw new InvalidOperationException($"Missing {name}");
static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

static IDisposable Acquire(string lockRoot)
{
    var path = Path.Combine(lockRoot, "update.lock");
    var started = DateTime.UtcNow;
    while (true)
    {
        try
        {
            var token = Guid.NewGuid().ToString("N");
            var stream = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read, 4096, FileOptions.WriteThrough);
            var owner = new { schema = 1, token, pid = Environment.ProcessId, hostname = Dns.GetHostName(), createdAt = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture) };
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(owner) + "\n");
            stream.Write(bytes); stream.Flush(true);
            return new OwnedLock(path, token, stream);
        }
        catch (IOException) when (DateTime.UtcNow - started < TimeSpan.FromSeconds(5)) { Thread.Sleep(50); }
    }
}

static void AtomicWrite(string path, object value)
{
    var temporary = Path.Combine(Path.GetDirectoryName(path)!, $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
    var json = JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine;
    using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
    using (var writer = new StreamWriter(stream, new UTF8Encoding(false))) { writer.Write(json); writer.Flush(); stream.Flush(true); }
    File.Move(temporary, path, true);
}

sealed class OwnedLock(string path, string token, FileStream stream) : IDisposable
{
    public void Dispose()
    {
        stream.Dispose();
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        if (document.RootElement.GetProperty("token").GetString() != token) throw new IOException("update.lock ownership changed");
        File.Delete(path);
    }
}
