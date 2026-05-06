#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// 获取当前文件的目录
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * 解析版本号字符串，返回版本号数组
 * @param {string} version - 版本号字符串，如 "1.0.0"
 * @returns {number[]} 版本号数组，如 [1, 0, 0]
 */
function parseVersion(version) {
  return version.split('.').map((num) => parseInt(num, 10))
}

/**
 * 将版本号数组转换为字符串
 * @param {number[]} versionArray - 版本号数组
 * @returns {string} 版本号字符串
 */
function versionToString(versionArray) {
  return versionArray.join('.')
}

/**
 * 升级小版本号（patch version）
 * @param {string} currentVersion - 当前版本号
 * @returns {string} 新版本号
 */
function bumpPatchVersion(currentVersion) {
  const versionArray = parseVersion(currentVersion)
  versionArray[2] += 1 // 增加 patch 版本号
  return versionToString(versionArray)
}

/**
 * 升级小版本号（minor version）
 * @param {string} currentVersion - 当前版本号
 * @returns {string} 新版本号
 */
function bumpMinorVersion(currentVersion) {
  const versionArray = parseVersion(currentVersion)
  versionArray[1] += 1 // 增加 minor 版本号
  versionArray[2] = 0 // 重置 patch 版本号
  return versionToString(versionArray)
}

/**
 * 升级主版本号（major version）
 * @param {string} currentVersion - 当前版本号
 * @returns {string} 新版本号
 */
function bumpMajorVersion(currentVersion) {
  const versionArray = parseVersion(currentVersion)
  versionArray[0] += 1 // 增加 major 版本号
  versionArray[1] = 0 // 重置 minor 版本号
  versionArray[2] = 0 // 重置 patch 版本号
  return versionToString(versionArray)
}

/**
 * 主函数
 */
function main() {
  try {
    // 读取 package.json 文件
    const packageJsonPath = join(__dirname, 'package.json')
    const packageJsonContent = readFileSync(packageJsonPath, 'utf8')
    const packageJson = JSON.parse(packageJsonContent)

    // 获取当前版本号
    const currentVersion = packageJson.version
    console.log(`当前版本: ${currentVersion}`)

    // 升级小版本号（patch version）
    const newVersion = bumpPatchVersion(currentVersion)
    console.log(`新版本: ${newVersion}`)

    // 更新 package.json 中的版本号
    packageJson.version = newVersion

    // 写回文件，保持格式
    writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8')

    console.log(`✅ 版本号已成功从 ${currentVersion} 升级到 ${newVersion}`)
  } catch (error) {
    console.error('❌ 升级版本号时发生错误:', error.message)
    process.exit(1)
  }
}

// 如果直接运行此脚本，则执行主函数
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}

export { bumpPatchVersion, bumpMinorVersion, bumpMajorVersion }
