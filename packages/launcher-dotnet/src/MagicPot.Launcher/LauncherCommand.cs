using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace MagicPot.Launcher;

public sealed record LauncherCommandRequestV1(int Schema, string RequestId, string Command, string RequestedAt, string? BuildId = null);
public sealed record LauncherCommandResultV1(int Schema, string RequestId, string Command, string Status, string CompletedAt, string? Error = null);

internal static partial class LauncherCommandStore
{
    internal const string RequestFileName = "launcher-command.json";
    internal const string ResultFileName = "launcher-command-result.json";
    internal static readonly TimeSpan MaximumAge = TimeSpan.FromHours(24);

    internal static LauncherCommandRequestV1? Consume(LauncherLayout layout, DateTimeOffset now)
    {
        string requestPath = Path.Combine(layout.Root, RequestFileName);
        if (!File.Exists(requestPath)) return null;
        string claimedPath = Path.Combine(layout.Root, $".{RequestFileName}.{Guid.NewGuid():N}.processing");
        string? claimedText = null;
        try
        {
            File.Move(requestPath, claimedPath, false);
            var claimedInfo = new FileInfo(claimedPath);
            claimedInfo.Refresh();
            if (!claimedInfo.Exists || claimedInfo.LinkTarget is not null ||
                (claimedInfo.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 ||
                claimedInfo.Length is <= 0 or > 4096)
                throw new ProtocolException("Claimed launcher command file is not a bounded regular file");
            claimedText = File.ReadAllText(claimedPath, new UTF8Encoding(false, true));
            LauncherCommandRequestV1 request = Parse(claimedText);
            var requestedAt = DateTimeOffset.ParseExact(request.RequestedAt, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal);
            if (requestedAt > now.AddMinutes(5) || now - requestedAt > MaximumAge) throw new ProtocolException("Launcher command is stale");
            return request;
        }
        catch (Exception error)
        {
            var (requestId, command) = RecoverCorrelation(claimedText);
            WriteResult(layout, new(1, requestId, command, "rejected", LauncherTime.Timestamp(now), error.Message));
            return null;
        }
        finally
        {
            try { if (File.Exists(claimedPath)) File.Delete(claimedPath); } catch { }
        }
    }

    internal static LauncherCommandRequestV1 Parse(string text)
    {
        using var document = JsonDocument.Parse(text);
        JsonElement root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new ProtocolException("Launcher command does not match schema 1");
        string[] names = root.EnumerateObject().Select(x => x.Name).ToArray();
        string command = root.TryGetProperty("command", out var commandValue) ? commandValue.GetString() ?? "" : "";
        string[] expected = command == "remove-version" ? ["schema", "requestId", "command", "requestedAt", "buildId"] : ["schema", "requestId", "command", "requestedAt"];
        if (names.Length != expected.Length || !expected.All(names.Contains)) throw new ProtocolException("Launcher command does not match schema 1");
        var request = new LauncherCommandRequestV1(root.GetProperty("schema").GetInt32(), root.GetProperty("requestId").GetString() ?? "", command, root.GetProperty("requestedAt").GetString() ?? "", root.TryGetProperty("buildId", out var buildId) ? buildId.GetString() : null);
        if (request.Schema != 1 || !RequestIdRegex().IsMatch(request.RequestId) || request.Command is not ("check-now" or "install-latest" or "rollback" or "remove-version") ||
            (request.Command == "remove-version" && !Protocol.IsBuildId(request.BuildId)) ||
            !DateTimeOffset.TryParseExact(request.RequestedAt, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out _))
            throw new ProtocolException("Launcher command does not match schema 1");
        return request;
    }

    private static (string RequestId, string Command) RecoverCorrelation(string? text)
    {
        if (text is null) return ("unknown", "unknown");
        try
        {
            using var document = JsonDocument.Parse(text);
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return ("unknown", "unknown");
            string requestId = root.TryGetProperty("requestId", out var id) && id.ValueKind == JsonValueKind.String && RequestIdRegex().IsMatch(id.GetString() ?? "") ? id.GetString()! : "unknown";
            string command = root.TryGetProperty("command", out var cmd) && cmd.ValueKind == JsonValueKind.String && cmd.GetString() is "check-now" or "install-latest" or "rollback" or "remove-version" ? cmd.GetString()! : "unknown";
            return (requestId, command);
        }
        catch { return ("unknown", "unknown"); }
    }

    internal static void WriteResult(LauncherLayout layout, LauncherCommandResultV1 result) => AtomicJson.Write(Path.Combine(layout.Root, ResultFileName), result);

    [GeneratedRegex("^[0-9a-f]{32}$", RegexOptions.CultureInvariant)]
    private static partial Regex RequestIdRegex();
}
