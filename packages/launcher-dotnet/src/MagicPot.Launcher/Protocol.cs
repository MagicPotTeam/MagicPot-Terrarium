using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace MagicPot.Launcher;

public sealed class ProtocolException(string message) : Exception(message);
public sealed record ActivePointerV1(int Schema, string ActiveBuildId, string ActiveRuntimeId, string? PreviousBuildId, string? PreviousRuntimeId, string ActivatedAt);
public sealed record InstalledFileV1(string Path, long Size, string Sha256);
public sealed record InstalledAppManifestV1(int Schema, string Kind, string Version, string BuildId, string CommitSha, string Platform, string Arch, string RuntimeId, string Entrypoint, string CreatedAt, long UnpackedSize, IReadOnlyList<InstalledFileV1>? Files);
public sealed record RuntimeEntrypointsV1(string Python, string Comfyui);
public sealed record InstalledRuntimeManifestV1(int Schema, string Kind, string RuntimeId, string Platform, string Arch, string CreatedAt, RuntimeEntrypointsV1 Entrypoints, long UnpackedSize, IReadOnlyList<InstalledFileV1>? Files);
public sealed record PendingLauncherHealthV1(string BuildId, string RuntimeId, string LaunchToken, int AttemptCount, string StartedAt, string Deadline);
public sealed record LauncherHealthConfirmationV1(string BuildId, string RuntimeId, string LaunchToken, string ConfirmedAt);
public sealed record LauncherHealthStateV1(int Schema, int FailedAttemptCount, PendingLauncherHealthV1? Pending = null, LauncherHealthConfirmationV1? LastHealthy = null);

public static partial class Protocol
{
    public const long MaxUnpackedSize = 1_099_511_627_776;
    public const int MaxLaunchAttempt = 10_000;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
    private static readonly HashSet<string> ReservedNames = new(StringComparer.OrdinalIgnoreCase)
    { "con", "prn", "aux", "nul", "conin$", "conout$", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9" };

    public static ActivePointerV1 ParseActivePointer(string text) => Parse(text, "active pointer", root =>
    {
        RequireKeys(root, ["schema", "activeBuildId", "activeRuntimeId", "activatedAt"], ["previousBuildId", "previousRuntimeId"]);
        var value = new ActivePointerV1(Int(root, "schema"), String(root, "activeBuildId"), String(root, "activeRuntimeId"), OptionalString(root, "previousBuildId"), OptionalString(root, "previousRuntimeId"), String(root, "activatedAt"));
        Require(value.Schema == 1 && IsBuildId(value.ActiveBuildId) && IsRuntimeId(value.ActiveRuntimeId) && IsTimestamp(value.ActivatedAt));
        Require((value.PreviousBuildId is null && value.PreviousRuntimeId is null) || (IsBuildId(value.PreviousBuildId) && IsRuntimeId(value.PreviousRuntimeId)));
        return value;
    });

    public static InstalledAppManifestV1 ParseAppManifest(string text) => Parse(text, "installed app manifest", root =>
    {
        RequireKeys(root, ["schema", "kind", "version", "buildId", "commitSha", "platform", "arch", "runtimeId", "entrypoint", "createdAt", "unpackedSize"], ["files"]);
        var value = new InstalledAppManifestV1(Int(root, "schema"), String(root, "kind"), String(root, "version"), String(root, "buildId"), String(root, "commitSha"), String(root, "platform"), String(root, "arch"), String(root, "runtimeId"), String(root, "entrypoint"), String(root, "createdAt"), Long(root, "unpackedSize"), Files(root));
        Require(value.Schema == 1 && value.Kind == "magicpot-app" && VersionRegex().IsMatch(value.Version) && IsBuildId(value.BuildId) && CommitRegex().IsMatch(value.CommitSha) && value.BuildId.EndsWith(value.CommitSha[..7], StringComparison.Ordinal) && value.Platform == "win32" && value.Arch == "x64" && IsRuntimeId(value.RuntimeId) && IsSafeRelativePath(value.Entrypoint) && value.Entrypoint.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && IsTimestamp(value.CreatedAt) && value.UnpackedSize is > 0 and <= MaxUnpackedSize);
        ValidateFiles(value.Files, value.UnpackedSize, [value.Entrypoint]);
        return value;
    });

    public static InstalledRuntimeManifestV1 ParseRuntimeManifest(string text) => Parse(text, "installed runtime manifest", root =>
    {
        RequireKeys(root, ["schema", "kind", "runtimeId", "platform", "arch", "createdAt", "entrypoints", "unpackedSize"], ["files"]);
        var entries = root.GetProperty("entrypoints");
        RequireKeys(entries, ["python", "comfyui"], []);
        var value = new InstalledRuntimeManifestV1(Int(root, "schema"), String(root, "kind"), String(root, "runtimeId"), String(root, "platform"), String(root, "arch"), String(root, "createdAt"), new(String(entries, "python"), String(entries, "comfyui")), Long(root, "unpackedSize"), Files(root));
        Require(value.Schema == 1 && value.Kind == "magicpot-runtime" && IsRuntimeId(value.RuntimeId) && value.Platform == "win32" && value.Arch == "x64" && IsTimestamp(value.CreatedAt) && IsSafeRelativePath(value.Entrypoints.Python) && value.Entrypoints.Python.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && IsSafeRelativePath(value.Entrypoints.Comfyui) && value.Entrypoints.Comfyui.EndsWith(".py", StringComparison.OrdinalIgnoreCase) && value.UnpackedSize is > 0 and <= MaxUnpackedSize);
        ValidateFiles(value.Files, value.UnpackedSize, [value.Entrypoints.Python, value.Entrypoints.Comfyui]);
        return value;
    });

    public static LauncherHealthStateV1 ParseHealth(string text) => Parse<LauncherHealthStateV1>(text, "launcher health state", root =>
    {
        RequireKeys(root, ["schema", "failedAttemptCount"], ["pending", "lastHealthy"]);
        var failed = Int(root, "failedAttemptCount");
        PendingLauncherHealthV1? pending = null;
        if (root.TryGetProperty("pending", out var item))
        {
            RequireKeys(item, ["buildId", "runtimeId", "launchToken", "attemptCount", "startedAt", "deadline"], []);
            pending = new(String(item, "buildId"), String(item, "runtimeId"), String(item, "launchToken"), Int(item, "attemptCount"), String(item, "startedAt"), String(item, "deadline"));
            Require(IsBuildId(pending.BuildId) && IsRuntimeId(pending.RuntimeId) && pending.LaunchToken.Length is > 0 and <= 256 && !string.IsNullOrWhiteSpace(pending.LaunchToken) && pending.AttemptCount is >= 1 and <= MaxLaunchAttempt && pending.AttemptCount == failed + 1 && IsCanonicalTimestamp(pending.StartedAt) && IsCanonicalTimestamp(pending.Deadline) && DateTimeOffset.Parse(pending.Deadline) > DateTimeOffset.Parse(pending.StartedAt));
        }
        LauncherHealthConfirmationV1? lastHealthy = null;
        if (root.TryGetProperty("lastHealthy", out var receipt))
        {
            RequireKeys(receipt, ["buildId", "runtimeId", "launchToken", "confirmedAt"], []);
            lastHealthy = new(String(receipt, "buildId"), String(receipt, "runtimeId"), String(receipt, "launchToken"), String(receipt, "confirmedAt"));
            Require(IsBuildId(lastHealthy.BuildId) && IsRuntimeId(lastHealthy.RuntimeId) && lastHealthy.LaunchToken.Length is > 0 and <= 256 && !string.IsNullOrWhiteSpace(lastHealthy.LaunchToken) && IsCanonicalTimestamp(lastHealthy.ConfirmedAt));
        }
        Require(Int(root, "schema") == 1 && failed is >= 0 and <= MaxLaunchAttempt);
        return new(1, failed, pending, lastHealthy);
    });

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, JsonOptions) + Environment.NewLine;
    public static bool IsBuildId(string? value) { if (value is null) return false; var match = BuildRegex().Match(value); return match.Success && IsDateParts(match.Groups.Values.Skip(1).Take(6).Select(x => x.Value).ToArray()); }
    public static bool IsRuntimeId(string? value) => value is not null && RuntimeRegex().IsMatch(value) && !value.Contains("..", StringComparison.Ordinal);
    public static bool IsSafeRelativePath(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 260 || Path.IsPathRooted(value) || DriveRegex().IsMatch(value) || value.Any(c => c <= 0x1f || ":<>\"|?*".Contains(c))) return false;
        foreach (var segment in value.Split(['/', '\\'])) { if (segment.Length == 0 || segment is "." or ".." || segment.EndsWith(' ') || segment.EndsWith('.')) return false; var stem = segment.Split('.')[0]; if (ReservedNames.Contains(segment) || ReservedNames.Contains(stem)) return false; }
        return true;
    }

    private static T Parse<T>(string text, string label, Func<JsonElement, T> parser)
    {
        try { using var document = JsonDocument.Parse(text); if (document.RootElement.ValueKind != JsonValueKind.Object) throw new ProtocolException($"{label} does not match schema 1"); return parser(document.RootElement); }
        catch (ProtocolException) { throw; }
        catch (Exception error) when (error is JsonException or InvalidOperationException or FormatException or OverflowException) { throw new ProtocolException($"{label} does not match schema 1: {error.Message}"); }
    }
    private static void ValidateFiles(IReadOnlyList<InstalledFileV1>? files, long expectedSize, IReadOnlyList<string> entrypoints)
    {
        if (files is null) return; Require(files.Count > 0 && files.Sum(x => x.Size) == expectedSize); var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in files) { Require(IsSafeRelativePath(file.Path) && !string.Equals(file.Path.Replace('\\', '/'), "manifest.json", StringComparison.OrdinalIgnoreCase) && file.Size is >= 0 and <= MaxUnpackedSize && ShaRegex().IsMatch(file.Sha256)); Require(paths.Add(file.Path.Replace('\\', '/'))); }
        Require(entrypoints.All(entry => paths.Contains(entry.Replace('\\', '/'))));
    }
    private static IReadOnlyList<InstalledFileV1>? Files(JsonElement root)
    {
        if (!root.TryGetProperty("files", out var array)) return null; Require(array.ValueKind == JsonValueKind.Array); var result = new List<InstalledFileV1>();
        foreach (var item in array.EnumerateArray()) { RequireKeys(item, ["path", "size", "sha256"], []); result.Add(new(String(item, "path"), Long(item, "size"), String(item, "sha256"))); } return result;
    }
    private static void RequireKeys(JsonElement value, IReadOnlyCollection<string> required, IReadOnlyCollection<string> optional) { Require(value.ValueKind == JsonValueKind.Object); var names = value.EnumerateObject().Select(x => x.Name).ToArray(); Require(required.All(names.Contains) && names.All(name => required.Contains(name) || optional.Contains(name))); }
    private static string String(JsonElement root, string name) => root.GetProperty(name).GetString() ?? throw new ProtocolException("Missing string");
    private static string? OptionalString(JsonElement root, string name) => root.TryGetProperty(name, out var value) ? value.GetString() ?? throw new ProtocolException("Optional string cannot be null") : null;
    private static int Int(JsonElement root, string name) => root.GetProperty(name).GetInt32();
    private static long Long(JsonElement root, string name) => root.GetProperty(name).GetInt64();
    private static void Require(bool condition) { if (!condition) throw new ProtocolException("Value does not match schema 1"); }
    private static bool IsTimestamp(string value) => IsCanonicalTimestamp(value);
    private static bool IsCanonicalTimestamp(string value) => DateTimeOffset.TryParseExact(value, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out _);
    private static bool IsDateParts(string[] p) => p.Length == 6 && DateTime.TryParseExact(string.Join("", p), "yyyyMMddHHmmss", null, System.Globalization.DateTimeStyles.None, out _);
    [GeneratedRegex(@"^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[0-9a-f]{7}$", RegexOptions.CultureInvariant)] private static partial Regex BuildRegex();
    [GeneratedRegex(@"^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$", RegexOptions.CultureInvariant)] private static partial Regex RuntimeRegex();
    [GeneratedRegex(@"^[0-9a-f]{40}$", RegexOptions.CultureInvariant)] private static partial Regex CommitRegex();
    [GeneratedRegex(@"^[0-9a-f]{64}$", RegexOptions.CultureInvariant)] private static partial Regex ShaRegex();
    [GeneratedRegex(@"^[0-9A-Za-z](?:[0-9A-Za-z.+-]{0,126}[0-9A-Za-z])?$", RegexOptions.CultureInvariant)] private static partial Regex VersionRegex();
    [GeneratedRegex(@"^[A-Za-z]:", RegexOptions.CultureInvariant)] private static partial Regex DriveRegex();
}
