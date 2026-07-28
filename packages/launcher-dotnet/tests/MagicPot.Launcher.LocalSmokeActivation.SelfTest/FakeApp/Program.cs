#if MAGICPOT_SMOKE_FAKE_APP
using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (!args.Contains("--update-smoke-test", StringComparer.Ordinal))
        {
            Console.WriteLine("healthy");
            return 0;
        }

        string? marker = Environment.GetEnvironmentVariable("MAGICPOT_TEST_MARKER");
        if (!string.IsNullOrEmpty(marker)) File.AppendAllText(marker, "smoke" + Environment.NewLine);

        string mode = Environment.GetEnvironmentVariable("MAGICPOT_TEST_SMOKE_MODE") ?? ReadModeFile() ?? "success";
        string build = Environment.GetEnvironmentVariable("MAGICPOT_ACTIVE_BUILD")
            ?? Environment.GetEnvironmentVariable("MAGICPOT_ACTIVE_BUILD_ID") ?? string.Empty;
        string version = Environment.GetEnvironmentVariable("MAGICPOT_TEST_APP_VERSION")
            ?? Environment.GetEnvironmentVariable("MAGICPOT_ACTIVE_VERSION") ?? "1.2.3";

        switch (mode)
        {
            case "nonzero": Console.Error.WriteLine("injected failure"); return 23;
            case "hang": Thread.Sleep(Timeout.Infinite); return 1;
            case "malformed": Console.WriteLine("not-json"); return 0;
            case "mismatch": build += "-wrong"; break;
            case "extra-output": Console.WriteLine("fake app diagnostic"); break;
            case "oversize": Console.Write(new string('x', 1024 * 1024 + 4096)); break;
            case "stderr-oversize": Console.Error.Write(new string('e', 1024 * 1024 + 4096)); break;
            case "invalid-utf8": Console.OpenStandardOutput().Write(new byte[] { 0xC3, 0x28 }); return 0;
            case "success": break;
            default: Console.Error.WriteLine("unknown smoke mode: " + mode); return 24;
        }

        Console.WriteLine(JsonSerializer.Serialize(new { ok = true, version, buildId = build }));
        return 0;
    }

    private static string? ReadModeFile()
    {
        string? path = Environment.GetEnvironmentVariable("MAGICPOT_TEST_SMOKE_MODE_FILE");
        return !string.IsNullOrWhiteSpace(path) && File.Exists(path) ? File.ReadAllText(path).Trim() : null;
    }
}
#endif
