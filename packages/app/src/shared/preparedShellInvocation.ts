import { executionPreparationSchema } from './executionPreparation'

/** Review material only. Never execute these arguments without a separate trusted host,
 * exact formal approval, executable identity, resource limits and owned cancellation.
 * No passwords, environment, PATH discovery, socket discovery or implicit target creation.
 */
export function planPreparedShellInvocation(preparation: unknown, code: string) {
  const target = executionPreparationSchema.parse(preparation)
  if (target.backend === 'database') throw new Error('Database preparation is not shell execution.')
  if (!code.trim() || code.includes('\0') || code.length > 6000 || new TextEncoder().encode(code).byteLength > 6000) {
    throw new Error('Reviewed code must be nonempty and at most 6000 UTF-8 bytes.')
  }
  if (target.backend === 'ssh') {
    // No shared host configuration/agent/password forwarding; known-hosts file is supplied
    // only by a future trusted host after checking the pinned key, never from model input.
    return {
      backend: 'ssh' as const, executableKind: 'trusted-ssh' as const,
      target, code,
      requiredHostKeySha256: target.hostKeySha256,
      requiresManagedKnownHosts: true,
      options: ['-F', 'none', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no',
        '-p', String(target.port), '-l', target.user, target.host],
      executionEnabled: false, grantsPermission: false,
      warning: 'Remote command and managed known-hosts/key arguments are intentionally not assembled. Stop is not remote rollback.'
    }
  }
  return {
    backend: 'docker' as const, executableKind: 'trusted-docker' as const,
    target, code,
    options: ['--context', target.context, 'exec', '-i', target.container, 'bash', '--noprofile', '--norc', '-s'],
    stdin: code,
    executionEnabled: false, grantsPermission: false,
    warning: 'Requires an existing explicitly approved container and trusted Docker executable/context identity. No daemon probe, pull, create, mount or privilege change. Container is not a sandbox certificate.'
  }
}
