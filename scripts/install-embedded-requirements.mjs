// Resolve the complete selected runtime in one transaction. Separate --upgrade
// installs can replace a dependency chosen for an earlier custom node with a
// version that violates that node's metadata (for example Hydra/OmegaConf).
export const embeddedRuntimeExtras = ['rotary-embedding-torch', 'compel==2.3.1', 'py-cord[voice]']

export function installEmbeddedRequirements({
  requirementFiles,
  constraintsPath,
  indexArgs,
  pip,
  extraRequirements = []
}) {
  if (!Array.isArray(requirementFiles) || requirementFiles.length === 0) {
    throw new Error('Embedded requirements must be nonempty')
  }
  pip([
    'install',
    '--upgrade',
    '--prefer-binary',
    ...requirementFiles.flatMap((file) => ['-r', file]),
    ...extraRequirements,
    '-c',
    constraintsPath,
    ...indexArgs
  ])
  pip(['check'])
}
