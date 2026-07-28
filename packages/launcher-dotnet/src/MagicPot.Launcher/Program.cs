using System.Text;
using System.Text.Json;

namespace MagicPot.Launcher;

internal static class Program
{
    [STAThread]
    private static async Task<int> Main(string[] args)
    {
        LauncherLayout? layout = null;
        try
        {
            var executableDirectory = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            var root = string.Equals(Path.GetFileName(executableDirectory), "launcher", StringComparison.OrdinalIgnoreCase)
                ? Directory.GetParent(executableDirectory)!.FullName
                : executableDirectory;
            layout = LauncherLayout.Create(root);
            return await new LauncherEngine(layout, updateConfiguration: CompiledLauncherUpdateConfiguration.Create()).RunAsync(args);
        }
        catch (IntegrityViolationException)
        {
            return IntegrityViolationException.ExitCode;
        }
        catch (Exception error)
        {
            if (layout is not null)
            {
                try
                {
                    Directory.CreateDirectory(layout.Root);
                    var line = JsonSerializer.Serialize(new { timestamp = LauncherTime.Timestamp(DateTimeOffset.UtcNow), level = "error", @event = "launcher_fatal", data = new { error = error.ToString() } }, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
                    File.AppendAllText(layout.Log, line + Environment.NewLine, new UTF8Encoding(false));
                }
                catch { }
            }
            return 1;
        }
    }
}
