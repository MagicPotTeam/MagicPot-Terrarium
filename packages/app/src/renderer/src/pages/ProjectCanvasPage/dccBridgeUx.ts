import type { DccBridgeTarget } from '@shared/api/svcDccBridge'

export type DccBridgePackagePaths = {
  packageDir: string
  manifestPath: string
  validationPath: string
  recipePath: string
  importStubPath: string
}

const getDccBridgeTargetLabel = (target: DccBridgeTarget): string =>
  target === 'unity' ? 'Unity' : 'Unreal'

export function getDccBridgeMenuCopy(target: DccBridgeTarget) {
  const targetLabel = getDccBridgeTargetLabel(target)
  return {
    primary: `Export to ${targetLabel}`,
    secondary: `Generate a manual ${targetLabel} handoff bundle in the configured bridge folder`
  }
}

export function getDccBridgeMenuTriggerTitle(): string {
  return 'Export a manual Unity / Unreal handoff bundle'
}

export function getDccBridgeDialogTitle(target: DccBridgeTarget): string {
  return target === 'unity'
    ? 'Choose a Unity Assets folder or a subfolder for the manual handoff bundle'
    : 'Choose an Unreal watched source folder for the manual handoff bundle'
}

export function getDccBridgeSuccessNotice(
  target: DccBridgeTarget,
  packageDir: string,
  packagePaths?: DccBridgePackagePaths
): string {
  const targetLabel = getDccBridgeTargetLabel(target)
  const lines = [
    `${targetLabel} manual handoff bundle generated: ${packageDir}`,
    `MagicPot only writes the package artifacts. ${targetLabel} import and execution remain manual.`
  ]

  if (packagePaths) {
    lines.push(`Manifest: ${packagePaths.manifestPath}`)
    lines.push(`Validation: ${packagePaths.validationPath}`)
    lines.push(`Recipe: ${packagePaths.recipePath}`)
    lines.push(`Import stub: ${packagePaths.importStubPath}`)
  }

  return lines.join('\n')
}

export function getDccBridgeFailureNotice(target: DccBridgeTarget, errorMessage: string): string {
  const targetLabel = getDccBridgeTargetLabel(target)
  return `${targetLabel} manual handoff bundle failed: ${errorMessage}. No ${targetLabel} automation or native import was launched.`
}
