import type { AdobeBridgeTarget } from '@shared/api/svcAdobeBridge'

export type AgentTargetApp = 'photoshop' | AdobeBridgeTarget

export type AdobeBridgePackagePaths = {
  packageDir: string
  manifestPath: string
  instructionsPath: string
  recipePath: string
  scriptStubPath?: string
}

export function getAgentTargetAppPrompt(targetApp: AgentTargetApp): string {
  switch (targetApp) {
    case 'photoshop':
      return 'Target app: Photoshop. Prefer scripts, action notes, or processing steps that can be executed directly in Photoshop.'
    case 'after-effects':
      return 'Target app: After Effects. Create a manual image + prompt handoff bundle with a manifest, instruction payload, recipe, and starter script stub, and clearly mark it as manual import/manual execution. Do not imply MagicPot will run After Effects automatically.'
    case 'premiere':
      return 'Target app: Premiere Pro. Create a manual image + prompt handoff bundle with a manifest, instruction payload, recipe, and starter script stub, and clearly mark it as manual import/manual execution. Do not imply MagicPot will run Premiere Pro automatically.'
  }
}

export function getAdobeBridgeMenuCopy(target: AdobeBridgeTarget) {
  if (target === 'after-effects') {
    return {
      primary: '\u53d1\u9001',
      secondary:
        '\u8ba9 Agent \u751f\u6210 AE \u811a\u672c\u3001\u8868\u8fbe\u5f0f\u6216\u7279\u6548\u6b65\u9aa4'
    }
  }

  return {
    primary: '\u53d1\u9001',
    secondary: '\u8ba9 Agent \u751f\u6210 PR \u526a\u8f91\u6216\u6548\u679c\u6b65\u9aa4'
  }
}

export function getAgentSendMenuCopy(target: AgentTargetApp) {
  if (target === 'photoshop') {
    return {
      primary: '\u53d1\u9001\u5230\u5f53\u524d Photoshop \u6587\u6863',
      secondary:
        '\u5c06\u5f53\u524d\u9009\u533a\u4f5c\u4e3a\u65b0\u56fe\u5c42\u63d2\u5165\u5df2\u6253\u5f00\u7684 Photoshop \u6587\u6863'
    }
  }

  return getAdobeBridgeMenuCopy(target)
}

export function getAdobeBridgeDialogTitle(target: AdobeBridgeTarget): string {
  return target === 'after-effects'
    ? 'Choose an After Effects manual handoff bundle folder'
    : 'Choose a Premiere Pro manual handoff bundle folder'
}

export function getAdobeBridgeSuccessNotice(
  target: AdobeBridgeTarget,
  packageDir: string,
  packagePaths?: AdobeBridgePackagePaths,
  scriptStubPath?: string
): string {
  const lines = [
    `${target === 'after-effects' ? 'After Effects' : 'Premiere Pro'} manual handoff bundle generated: ${packageDir}`,
    'MagicPot only writes the package artifacts; Adobe execution remains manual.'
  ]
  if (packagePaths) {
    lines.push(`Manifest: ${packagePaths.manifestPath}`)
    lines.push(`Instructions: ${packagePaths.instructionsPath}`)
    lines.push(`Recipe: ${packagePaths.recipePath}`)
  }
  if (scriptStubPath?.trim()) {
    lines.push(`Starter script stub: ${scriptStubPath}`)
  }
  return lines.join('\n')
}

export function getAdobeBridgeFailureNotice(
  target: AdobeBridgeTarget,
  errorMessage: string
): string {
  return `${target === 'after-effects' ? 'After Effects' : 'Premiere Pro'} manual handoff bundle failed: ${errorMessage}. No Adobe automation was launched.`
}
