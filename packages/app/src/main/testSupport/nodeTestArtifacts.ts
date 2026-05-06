import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  readTestUiEnv,
  resolveConfiguredDesktopPath,
  resolveTestArtifactPath,
  resolveTestUiPolicy
} from '../testUiPolicy'

const nodeTestPolicy = resolveTestUiPolicy({
  ...readTestUiEnv(),
  automatedRun: true
})

export function resolveNodeTestArtifactRoot(): string {
  return resolveTestArtifactPath({
    desktopPath: resolveConfiguredDesktopPath(path.join(os.homedir(), 'Desktop')),
    tempPath: os.tmpdir(),
    policy: nodeTestPolicy,
    segments: []
  })
}

export function resolveNodeTestArtifactPath(...segments: string[]): string {
  return path.join(resolveNodeTestArtifactRoot(), 'node-tests', ...segments)
}

export async function createNodeTestArtifactDir(label: string, prefix = 'run-'): Promise<string> {
  const baseDir = resolveNodeTestArtifactPath(label)
  await fs.mkdir(baseDir, { recursive: true })
  return fs.mkdtemp(path.join(baseDir, prefix))
}
