/* eslint-disable */
const fs = require('fs')
const path = require('path')

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
    return true
  }
  return false
}

function ensurePlaceholderFile(dirPath, fileName) {
  if (!fileName) return

  const placeholderPath = path.join(dirPath, fileName)
  if (!fs.existsSync(placeholderPath)) {
    fs.writeFileSync(placeholderPath, '')
  }

  const gitkeepPath = path.join(dirPath, '.gitkeep')
  if (fs.existsSync(gitkeepPath)) {
    fs.rmSync(gitkeepPath, { force: true })
  }
}

function pruneElectronLocales(unpackDir) {
  const localesDir = path.join(unpackDir, 'locales')
  if (!fs.existsSync(localesDir)) return

  const keepLocales = new Set(['en-US.pak', 'zh-CN.pak', 'zh-TW.pak'])
  let removed = 0
  for (const fileName of fs.readdirSync(localesDir)) {
    if (keepLocales.has(fileName)) continue
    const localePath = path.join(localesDir, fileName)
    if (fs.statSync(localePath).isFile()) {
      fs.rmSync(localePath, { force: true })
      removed += 1
    }
  }

  console.log(`[afterPack] Pruned ${removed} Electron locale files`)
}

exports.default = async function (context) {
  // 只在 embedded 模式下运行
  if (process.env.PACKAGE_MODE !== 'embedded') return

  const unpackDir = context.appOutDir
  const comfyDir = path.join(unpackDir, 'ComfyUI_windows_portable', 'ComfyUI')

  const dirsToCreate = ['models', 'input', 'output', 'user/default/workflows']

  console.log(`[afterPack] Creating empty ComfyUI directories in ${comfyDir}...`)

  for (const dir of dirsToCreate) {
    const fullPath = path.join(comfyDir, dir)
    if (ensureDir(fullPath)) {
      console.log(`  Created: ${dir}`)
    }
  }

  // 确保 models 子目录也存在（与官方 ComfyUI 仓库保持一致）
  const modelPlaceholderFiles = {
    audio_encoders: 'put_audio_encoder_models_here',
    checkpoints: 'put_checkpoints_here',
    clip: 'put_clip_or_text_encoder_models_here',
    clip_vision: 'put_clip_vision_models_here',
    configs: null,
    controlnet: 'put_controlnets_and_t2i_here',
    diffusers: 'put_diffusers_models_here',
    diffusion_models: 'put_diffusion_model_files_here',
    embeddings: 'put_embeddings_or_textual_inversion_concepts_here',
    gligen: 'put_gligen_models_here',
    hypernetworks: 'put_hypernetworks_here',
    ipadapter: 'put_ipadapter_models_here',
    kgen: 'put_kgen_models_here',
    latent_upscale_models: 'put_latent_upscale_models_here',
    loras: 'put_loras_here',
    model_patches: 'put_model_patches_here',
    photomaker: 'put_photomaker_models_here',
    sams: 'put_sams_models_here',
    SEEDVR2: 'put_seedvr2_models_here',
    style_models: 'put_t2i_style_model_here',
    text_encoders: 'put_text_encoder_files_here',
    ultralytics: 'put_ultralytics_models_here',
    unet: 'put_unet_files_here',
    upscale_models: 'put_esrgan_and_other_upscale_models_here',
    vae: 'put_vae_here',
    vae_approx: 'put_taesd_encoder_pth_and_taesd_decoder_pth_here'
  }
  for (const [subdir, placeholderFile] of Object.entries(modelPlaceholderFiles)) {
    const fullPath = path.join(comfyDir, 'models', subdir)
    if (ensureDir(fullPath)) {
      console.log(`  Created model subdir: ${subdir}`)
    }
    ensurePlaceholderFile(fullPath, placeholderFile)
  }

  // 清理用户历史工作流文件，只保留占位文件
  // Clean user workflow history, keep only a placeholder file.
  const workflowDir = path.join(comfyDir, 'user', 'default', 'workflows')
  if (fs.existsSync(workflowDir)) {
    console.log(`[afterPack] Cleaning user workflows in ${workflowDir}...`)
    const files = fs.readdirSync(workflowDir)
    for (const file of files) {
      if (file.endsWith('.json')) {
        fs.unlinkSync(path.join(workflowDir, file))
        console.log(`  Deleted: ${file}`)
      }
    }
    ensurePlaceholderFile(workflowDir, 'put_workflows_here')
  }

  // 将 README 复制到根目录，方便用户发现
  const readmeSrc = path.join(unpackDir, 'ComfyUI_windows_portable', 'README_VERY_IMPORTANT.txt')
  const readmeDst = path.join(unpackDir, '模型下载说明.txt')
  if (fs.existsSync(readmeSrc)) {
    fs.copyFileSync(readmeSrc, readmeDst)
    console.log(`[afterPack] Copied README to root: ${readmeDst}`)
  }

  pruneElectronLocales(unpackDir)
}
