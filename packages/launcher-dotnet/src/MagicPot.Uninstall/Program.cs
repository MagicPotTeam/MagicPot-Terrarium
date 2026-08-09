using MagicPot.Launcher;
static string Need(string[] args, string name)
{
    int index = Array.IndexOf(args, name);
    if (index < 0 || index + 1 == args.Length) throw new ArgumentException(name + " is required.");
    return args[index + 1];
}

try
{
    int phase = args.Contains("--phase2", StringComparer.Ordinal) ? 2 : 1;
    int? parentProcessId = null;
    int parentIndex = Array.IndexOf(args, "--parent-pid");
    if (parentIndex >= 0)
    {
        if (parentIndex + 1 == args.Length || !int.TryParse(args[parentIndex + 1], out int parsedParent) || parsedParent <= 0)
        {
            throw new ArgumentException("--parent-pid must be a positive integer.");
        }
        parentProcessId = parsedParent;
    }

    string root = Need(args, "--root");
    string installId = Need(args, "--install-id");
    bool quiet = args.Contains("--quiet", StringComparer.Ordinal);

    var core = new UninstallerCore(
        new WindowsUninstallProcessBackend(),
        new MoveFileExTempSelfCleanup(),
        (candidateRoot, candidateInstallId) => UninstallCapabilityBuilder.Build(candidateRoot, candidateInstallId),
        () => new WindowsInstallIntegration());

    UninstallerResult result = core.Run(new UninstallerRequest(root, installId, phase, parentProcessId, quiet));
    Environment.ExitCode = result == UninstallerResult.Handoff ? 0 : 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine(ex.Message);
    Environment.ExitCode = 1;
}
