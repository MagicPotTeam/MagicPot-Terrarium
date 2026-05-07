#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..', '..')
const packageJsonPath = path.join(repoRoot, 'package.json')
const packageLockPath = path.join(repoRoot, 'package-lock.json')

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) {
    throw new Error(`Expected semver version in package.json, received: ${version}`)
  }
  return match.slice(1).map((part) => Number(part))
}

function versionToString(versionArray) {
  return versionArray.join('.')
}

function bumpPatchVersion(currentVersion) {
  const versionArray = parseVersion(currentVersion)
  versionArray[2] += 1
  return versionToString(versionArray)
}

function bumpMinorVersion(currentVersion) {
  const versionArray = parseVersion(currentVersion)
  versionArray[1] += 1
  versionArray[2] = 0
  return versionToString(versionArray)
}

function bumpMajorVersion(currentVersion) {
  const versionArray = parseVersion(currentVersion)
  versionArray[0] += 1
  versionArray[1] = 0
  versionArray[2] = 0
  return versionToString(versionArray)
}

function writeJsonFile(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function updatePackageLockVersion(newVersion) {
  const packageLock = JSON.parse(readFileSync(packageLockPath, 'utf8'))
  packageLock.version = newVersion

  if (packageLock.packages?.['']) {
    packageLock.packages[''].version = newVersion
  }

  writeJsonFile(packageLockPath, packageLock)
}

function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run')
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const currentVersion = packageJson.version
  const newVersion = bumpPatchVersion(currentVersion)

  console.log(`Current version: ${currentVersion}`)
  console.log(`Next version: ${newVersion}`)

  if (dryRun) {
    return
  }

  packageJson.version = newVersion
  writeJsonFile(packageJsonPath, packageJson)
  updatePackageLockVersion(newVersion)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

export { bumpPatchVersion, bumpMinorVersion, bumpMajorVersion, main }
