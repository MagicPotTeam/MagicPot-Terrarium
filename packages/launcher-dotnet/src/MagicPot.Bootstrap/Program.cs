using System.Runtime.InteropServices;
using MagicPot.Launcher;

namespace MagicPot.Bootstrap;

internal static class Program
{
    internal const int Success = 0, InvalidArguments = 2, VerificationFailed = 3, InstallFailed = 4, UnsupportedPlatform = 5;

    [STAThread]
    private static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindows()) return UnsupportedPlatform;
        try
        {
            BootstrapCommandLine options = args.Length == 0
                ? BootstrapCommandLine.FromExecutablePath(Environment.ProcessPath)
                : BootstrapCommandLine.Parse(args);
            string root = BootstrapExecutableFacade.InstallAsync(options.Descriptor, options.Signature, options.InstallRoot, options.LegacySourceLabel).GetAwaiter().GetResult();
            MessageBoxW(IntPtr.Zero, "MagicPot is ready.\n\n" + root, "MagicPot", 0x40);
            return Success;
        }
        catch (ArgumentException error) { MessageBoxW(IntPtr.Zero, error.Message, "MagicPot", 0x10); return InvalidArguments; }
        catch (Exception error) when (error.Message.Contains("signature", StringComparison.OrdinalIgnoreCase) || error.Message.Contains("trust", StringComparison.OrdinalIgnoreCase) || error.Message.Contains("descriptor", StringComparison.OrdinalIgnoreCase) || error.Message.Contains("manifest", StringComparison.OrdinalIgnoreCase) || error.Message.Contains("payload identity", StringComparison.OrdinalIgnoreCase))
        { MessageBoxW(IntPtr.Zero, "Verification failed.\n\n" + error.Message, "MagicPot", 0x10); return VerificationFailed; }
        catch (Exception error) { MessageBoxW(IntPtr.Zero, "Setup failed.\n\n" + error.Message, "MagicPot", 0x10); return InstallFailed; }
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int MessageBoxW(IntPtr window, string text, string caption, uint type);
}

internal sealed record BootstrapCommandLine(string Descriptor, string Signature, string? InstallRoot, string? LegacySourceLabel)
{
    private const string DescriptorFileName = "MagicPot.Bootstrap.json";
    private const string SignatureFileName = "MagicPot.Bootstrap.sig";

    internal static BootstrapCommandLine FromExecutablePath(string? executablePath)
    {
        if (string.IsNullOrWhiteSpace(executablePath) || !Path.IsPathFullyQualified(executablePath))
            throw new ArgumentException("Bootstrap executable path is unavailable.");
        string fullExecutablePath = Path.GetFullPath(executablePath);
        string? executableDirectory = Path.GetDirectoryName(fullExecutablePath);
        if (string.IsNullOrWhiteSpace(executableDirectory) || !Path.IsPathFullyQualified(executableDirectory))
            throw new ArgumentException("Bootstrap executable directory is unavailable.");
        return new(Path.Combine(executableDirectory, DescriptorFileName), Path.Combine(executableDirectory, SignatureFileName), null, null);
    }

    internal static BootstrapCommandLine Parse(IReadOnlyList<string> args)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        var allowed = new HashSet<string>(StringComparer.Ordinal) { "--descriptor", "--signature", "--install-root", "--legacy-source-label" };
        if (args.Count % 2 != 0) throw new ArgumentException("Every option requires a value.");
        for (int i = 0; i < args.Count; i += 2)
        {
            string option = args[i], value = args[i + 1];
            if (!allowed.Contains(option)) throw new ArgumentException("Unknown option: " + option);
            if (string.IsNullOrWhiteSpace(value) || value.StartsWith("--", StringComparison.Ordinal)) throw new ArgumentException("Missing value for " + option);
            if (!values.TryAdd(option, value)) throw new ArgumentException("Duplicate option: " + option);
        }
        string Need(string name) => values.TryGetValue(name, out string? value) ? Absolute(value, name) : throw new ArgumentException("Missing required option: " + name);
        string? OptionalPath(string name) => values.TryGetValue(name, out string? value) ? Absolute(value, name) : null;
        string? label = values.GetValueOrDefault("--legacy-source-label");
        if (label is not null && (label.Length > 256 || label.Any(static c => c < ' '))) throw new ArgumentException("--legacy-source-label must be at most 256 printable characters.");
        return new(Need("--descriptor"), Need("--signature"), OptionalPath("--install-root"), label);
    }
    private static string Absolute(string value, string option) => Path.IsPathFullyQualified(value) ? Path.GetFullPath(value) : throw new ArgumentException(option + " must be an absolute path.");
}
