import os from 'os'
import path from 'path'
import { readTestUiEnv, resolveTestArtifactPath, resolveTestUiPolicy } from '../testUiPolicy'

export const resolveDuplicateCheckTempRoot = (): string =>
  resolveTestArtifactPath({
    desktopPath: path.join(os.homedir(), 'Desktop'),
    tempPath: os.tmpdir(),
    policy: resolveTestUiPolicy(readTestUiEnv()),
    segments: ['duplicate-check']
  })
