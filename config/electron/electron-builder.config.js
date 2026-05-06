/**
 * @type {import('electron-builder').Configuration}
 */

// default to pure mode
const packageMode = process.env.PACKAGE_MODE || 'pure'
const runtimeAssetsDir = 'packages/runtime-assets'
const buildResourcesDir = `${runtimeAssetsDir}/build`
const appResourcesDir = `${runtimeAssetsDir}/resources`
const comfySourceDir = 'vendor/comfyui'
const packagedComfyDir = 'ComfyUI_windows_portable'

const embeddedComfyUIStageFiles = {
  from: '.staging/embedded/ComfyUI',
  to: `${packagedComfyDir}/ComfyUI`
}

const embeddedPythonStageFiles = {
  from: '.staging/embedded/python_embeded',
  to: `${packagedComfyDir}/python_embeded`,
  filter: ['**/*', '!**/__pycache__/*', '!**/*.pyc']
}

const comfySourceFile = (relativePath) => ({
  from: `${comfySourceDir}/${relativePath}`,
  to: `${packagedComfyDir}/${relativePath}`
})

const modeMap = {
  embedded: {
    productName: 'magicpot-embedded',
    distDir: 'dist/embedded',
    winExtraFiles: [
      embeddedComfyUIStageFiles,
      embeddedPythonStageFiles,
      comfySourceFile('README_VERY_IMPORTANT.txt'),
      comfySourceFile('run_cpu.bat'),
      comfySourceFile('run_nvidia_gpu.bat'),
      comfySourceFile('run_nvidia_gpu_fast_fp16_accumulation.bat'),
      comfySourceFile('advanced'),
      comfySourceFile('update')
    ],
    winTarget: ['dir', 'zip'], // NSIS 不适合大包（python_embeded 文件过多）
    nsis: {
      oneClick: false, // 允许选择安装目录 (对于大包建议 false)
      allowToChangeInstallationDirectory: true,
      perMachine: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      unicode: true,
      artifactName: '${productName}-${version}-setup.${ext}',
      shortcutName: '${productName}',
      uninstallDisplayName: '${productName}',
      include: `${buildResourcesDir}/uninstaller.nsh`
    },
    afterPack: `${buildResourcesDir}/afterPack.js`,
    macExtraFiles: [
      embeddedComfyUIStageFiles,
      comfySourceFile('python_embedded_macos'),
      `!${comfySourceDir}/python_embedded_macos/**/__pycache__/*`
    ],
    linuxExtraFiles: [embeddedComfyUIStageFiles]
  },
  pure: {
    productName: 'magicpot-pure',
    distDir: 'dist/pure',
    winExtraFiles: [],
    winTarget: ['dir', 'zip', 'nsis'],
    macExtraFiles: [],
    linuxExtraFiles: [],
    nsis: {
      oneClick: false, // 允许选择安装目录
      allowToChangeInstallationDirectory: true,
      perMachine: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      // allowToChangeInstallationDirectory: true, // oneClick 模式不支持
      unicode: true,
      artifactName: '${productName}-${version}-setup.${ext}',
      shortcutName: '${productName}',
      uninstallDisplayName: '${productName}',
      include: `${buildResourcesDir}/pure-installer.nsh` // pure installer options plus uninstall cleanup
    }
  }
}

function isBuildMode(mode) {
  return Object.keys(modeMap).includes(mode)
}

if (!isBuildMode(packageMode)) {
  throw new Error('BUILD_MODE is not set or invalid')
}

const modeConfig = modeMap[packageMode]

const bundledContentExtraFiles = [
  { from: 'packages/qapps', to: 'qApps' },
  { from: 'packages/skills', to: 'customSkills' },
  { from: 'packages/target-schemes', to: 'targetSchemes' },
  { from: appResourcesDir, to: appResourcesDir }
]

const config = {
  appId: 'com.magicpot.app',
  productName: modeConfig.productName,
  directories: {
    buildResources: buildResourcesDir,
    output: modeConfig.distDir
  },
  files: ['out', 'README.md', 'LICENSE'],
  extraFiles: bundledContentExtraFiles,
  asar: true,
  asarUnpack: ['**/*.safetensors', '**/*.ckpt', '**/*.pt', '**/*.pth', '**/models/**/*'],
  win: {
    icon: `${buildResourcesDir}/icon.png`,
    defaultArch: 'x64',
    extraFiles: modeConfig.winExtraFiles,
    target: modeConfig.winTarget,
    // 禁用代码签名，避免 winCodeSign 符号链接权限问题
    sign: null,
    signDlls: false
  },
  nsis: modeConfig.nsis,
  mac: {
    icon: `${buildResourcesDir}/icon.png`,
    entitlementsInherit: `${buildResourcesDir}/entitlements.mac.plist`,
    defaultArch: 'arm64',
    extendInfo: [
      {
        NSDocumentsFolderUsageDescription:
          "Application requests access to the user's Documents folder."
      },
      {
        NSDownloadsFolderUsageDescription:
          "Application requests access to the user's Downloads folder."
      }
    ],

    notarize: false,
    extraFiles: modeConfig.macExtraFiles
  },
  linux: {
    extraFiles: modeConfig.linuxExtraFiles
  },
  dmg: {
    artifactName: '${productName}-${version}.${ext}'
  },
  npmRebuild: false,
  electronDownload: {
    mirror: 'https://npmmirror.com/mirrors/electron/'
  },
  afterPack: modeConfig.afterPack || undefined
}

module.exports = config
