import crypto from 'node:crypto'
import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  LAUNCHER_COMMAND_FILE,
  LAUNCHER_COMMAND_RESULT_FILE,
  type LauncherCommand,
  type LauncherCommandReceipt,
  type LauncherCommandRequestV1,
  type LauncherCommandResultV1,
  parseLauncherCommandResult,
  serializeLauncherCommandRequest
} from '../../shared/appUpdate/launcherProtocol'
import { resolveValidatedLauncherBinding, type AppLauncherBridgeOptions } from './appLauncherBridge'

const MAX_CREATE_ATTEMPTS = 4

export interface LauncherCommandOptions extends Omit<AppLauncherBridgeOptions, 'app'> {
  app?: AppLauncherBridgeOptions['app']
  now?: () => Date
  randomId?: () => string
}

function bridgeOptions(options: LauncherCommandOptions): AppLauncherBridgeOptions {
  const { now: _now, randomId: _randomId, ...bridge } = options
  return { ...bridge, app: options.app ?? app }
}

export async function readLauncherCommandResult(
  expectedRequestId: string,
  options: LauncherCommandOptions = {}
): Promise<LauncherCommandResultV1 | undefined> {
  const binding = await resolveValidatedLauncherBinding(bridgeOptions(options))
  if (!binding) return undefined
  try {
    const result = parseLauncherCommandResult(
      await fs.readFile(path.join(binding.root, LAUNCHER_COMMAND_RESULT_FILE), 'utf8')
    )
    return result.requestId === expectedRequestId ? result : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return undefined
  }
}

export async function readLastLauncherCommandResult(
  options: LauncherCommandOptions = {}
): Promise<LauncherCommandResultV1 | undefined> {
  const binding = await resolveValidatedLauncherBinding(bridgeOptions(options))
  if (!binding) return undefined
  try {
    return parseLauncherCommandResult(
      await fs.readFile(path.join(binding.root, LAUNCHER_COMMAND_RESULT_FILE), 'utf8')
    )
  } catch {
    return undefined
  }
}

export async function writeLauncherCommand(
  command: LauncherCommand,
  options: LauncherCommandOptions = {},
  buildId?: string
): Promise<LauncherCommandReceipt> {
  const binding = await resolveValidatedLauncherBinding(bridgeOptions(options))
  if (!binding) return { accepted: false, command, error: 'Launcher-managed launch is unavailable' }

  const destination = path.join(binding.root, LAUNCHER_COMMAND_FILE)
  const resultPath = path.join(binding.root, LAUNCHER_COMMAND_RESULT_FILE)
  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
    const request: LauncherCommandRequestV1 = {
      schema: 1,
      requestId: (options.randomId ?? (() => crypto.randomBytes(16).toString('hex')))(),
      command,
      requestedAt: (options.now ?? (() => new Date()))().toISOString(),
      ...(command === 'remove-version' ? { buildId } : {})
    }
    const temporary = path.join(binding.root, `.${LAUNCHER_COMMAND_FILE}.${request.requestId}.tmp`)
    try {
      const handle = await fs.open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(serializeLauncherCommandRequest(request), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.unlink(resultPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      await fs.link(temporary, destination)
      return {
        accepted: true,
        command,
        requestId: request.requestId,
        requestedAt: request.requestedAt
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { accepted: false, command, error: 'Another launcher command is already pending' }
      }
      if (attempt === MAX_CREATE_ATTEMPTS - 1)
        return {
          accepted: false,
          command,
          error: error instanceof Error ? error.message : String(error)
        }
    } finally {
      await fs.unlink(temporary).catch(() => undefined)
    }
  }
  return { accepted: false, command, error: 'Unable to create launcher command' }
}
