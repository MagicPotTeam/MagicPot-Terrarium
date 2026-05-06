import fs from 'fs/promises'
import path from 'path'
import { Config, DEFAULT_CONFIG } from '@shared/config/config'
import { deepMerge, DeepPartial } from '@shared/utils/utilTypes'
import { getBuildEnv } from './buildEnv'
import { exists } from '../utils/fileUtils'
import { EventCenter, EventListener } from '../utils/eventCenter'
import { migrateConfig } from './config_migration'

const CONFIG_FILENAME = 'config.json'

function serializeConfig(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function sanitizeConfigText(text: string): string {
  return text.replace(/\uFEFF/g, '').replaceAll('\0', '')
}

async function writeConfigAtomically(configPath: string, contents: string) {
  const tempPath = `${configPath}.${Date.now()}.tmp`
  await fs.writeFile(tempPath, contents, 'utf-8')
  await fs.rename(tempPath, configPath)
}

function getConfigPath() {
  const buildEnv = getBuildEnv()
  return path.join(buildEnv.pathMap.data, CONFIG_FILENAME)
}

let configCache: Config | null = null
const eventCenter: EventCenter<Config> = new EventCenter<Config>()

async function loadConfigFromFile(): Promise<Config> {
  const configPath = getConfigPath()
  let rawConfig: unknown = {}
  let shouldPersistNormalizedConfig = false

  if (await exists(configPath)) {
    try {
      rawConfig = JSON.parse(sanitizeConfigText(await fs.readFile(configPath, 'utf8')))
      shouldPersistNormalizedConfig = true
    } catch (error) {
      const backupPath = `${configPath}.broken-${Date.now()}.bak`
      console.error('[Config] Failed to parse config, falling back to defaults:', error)
      try {
        await fs.copyFile(configPath, backupPath)
        console.warn(`[Config] Backed up invalid config to ${backupPath}`)
      } catch (backupError) {
        console.error('[Config] Failed to back up invalid config:', backupError)
      }
      rawConfig = {}
      shouldPersistNormalizedConfig = false
    }
  } else {
    shouldPersistNormalizedConfig = true
  }

  const migratedConfig = migrateConfig(rawConfig)
  // Config stays JSON-serializable, but DeepPartial with record-like MCP fields is wider than JsonValue.
  configCache = deepMerge(DEFAULT_CONFIG as never, migratedConfig as never) as Config

  // Persist the normalized structure once so later launches do not depend on migration.
  if (
    shouldPersistNormalizedConfig &&
    serializeConfig(rawConfig) !== serializeConfig(configCache)
  ) {
    await writeConfigAtomically(configPath, serializeConfig(configCache))
  }

  return configCache
}

export async function initConfig() {
  await loadConfigFromFile()
  await eventCenter.emit(configCache!)
}

export function getConfig(): Config {
  if (configCache === null) {
    throw new Error('Config not initialized')
  }
  return configCache
}

export async function saveConfig(config: DeepPartial<Config>) {
  const configPath = getConfigPath()
  const oldConfig = getConfig()

  const newConfig = deepMerge(oldConfig as never, config as never) as Config
  await writeConfigAtomically(configPath, serializeConfig(newConfig))
  configCache = newConfig
  await eventCenter.emit(newConfig)
}

export function listenConfig(listener: EventListener<Config>) {
  eventCenter.addListener(listener)
}
