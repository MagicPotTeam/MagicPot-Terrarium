using System;
using System.Collections.Generic;

namespace MagicPot.Launcher;

internal static class CompiledBootstrapTrustConfiguration
{
    internal static BootstrapTrustConfiguration Create() => BootstrapTrustConfiguration.CreateCompiled(
        true,
        new Dictionary<string, byte[]>(StringComparer.Ordinal) { ["descriptor"] = Convert.FromBase64String("6NpjpAymh8h8/OBcskp4bH51zEnHDbVXPwJvHGqGzqo=") },
        new Dictionary<string, byte[]>(StringComparer.Ordinal) { ["manifest"] = Convert.FromBase64String("Zr5+Myx6RTMyvZ0Kf32wVfXF7xoGraZtmLOftoEMRzo=") });
}
