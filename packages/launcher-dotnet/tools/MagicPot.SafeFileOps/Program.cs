using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using MagicPot.SafeFileOps;

internal static class Program
{
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length > 0 && args[0] == "inspect-file")
            {
                SafeInspectResult result = SafeFileOpsCore.InspectFile(ParseInspect(args));
                Console.Out.WriteLine(JsonSerializer.Serialize(new { status = result.Status, volumeSerial = result.VolumeSerial.ToString(), fileIndex = result.FileIndex.ToString() }));
                return result.ExitCode;
            }
            SafeDeleteResult delete = SafeFileOpsCore.DeleteFile(ParseDelete(args));
            return Write(delete);
        }
        catch (ArgumentException) { return Write(new(2, "invalid-arguments")); }
        catch { return Write(new(2, "system-error")); }
    }

    private static Dictionary<string, string> ParseValues(string[] args, int expectedLength, string command)
    {
        if (args.Length != expectedLength || args[0] != command) throw new ArgumentException();
        Dictionary<string, string> values = new(StringComparer.Ordinal);
        for (int i = 1; i < args.Length; i += 2) if (i + 1 >= args.Length || !values.TryAdd(args[i], args[i + 1])) throw new ArgumentException();
        return values;
    }

    private static SafeInspectRequest ParseInspect(string[] args)
    {
        Dictionary<string, string> values = ParseValues(args, 5, "inspect-file");
        if (!values.TryGetValue("--root", out string? root) || !values.TryGetValue("--path", out string? path) ||
            !Path.IsPathFullyQualified(root) || !Path.IsPathFullyQualified(path)) throw new ArgumentException();
        return new(root, path);
    }

    private static SafeDeleteRequest ParseDelete(string[] args)
    {
        Dictionary<string, string> values = ParseValues(args, 9, "delete-file");
        if (!values.TryGetValue("--root", out string? root) || !values.TryGetValue("--path", out string? path) ||
            !values.TryGetValue("--volume-serial", out string? volumeText) || !values.TryGetValue("--file-index", out string? indexText) ||
            !Path.IsPathFullyQualified(root) || !Path.IsPathFullyQualified(path) || !uint.TryParse(volumeText, out uint volume) || !ulong.TryParse(indexText, out ulong index)) throw new ArgumentException();
        return new(root, path, volume, index);
    }

    private static int Write(SafeDeleteResult result) { Console.Out.WriteLine(JsonSerializer.Serialize(new { status = result.Status })); return result.ExitCode; }
}
