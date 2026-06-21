import React from 'react'
import {
  Box,
  Button,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material'
import AddPhotoAlternateOutlinedIcon from '@mui/icons-material/AddPhotoAlternateOutlined'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'

import PanelShell from './PanelShell'
import { PBR_MATERIAL_INFO, ParamSegment, SectionLabel, TipBanner } from './ui'
import { hyColors, hySwitchSx } from './theme'
import type { Hy3dApiAction, Hy3dImageAttachment, Hy3dMediaState, Hy3dParams } from './types'
import {
  FACE_LEVEL_OPTIONS,
  getTripoWorkflowStepIdForAction,
  POLYGON_TYPE_OPTIONS,
  TRIPO_ANIMATION_PRESETS,
  TRIPO_CONVERT_TARGET_FORMATS,
  TRIPO_IMAGE_MODEL_VERSION_OPTIONS,
  TRIPO_RIG_SPEC_OPTIONS,
  TRIPO_RIG_TYPE_OPTIONS,
  TRIPO_TEMPLATE_OPTIONS
} from './types'

interface TripoTaskPanelProps {
  params: Hy3dParams
  mediaState: Hy3dMediaState
  onParamsChange: (p: Partial<Hy3dParams>) => void
  onMediaStateChange: (state: Partial<Hy3dMediaState>) => void
  onGenerate?: () => void
}

type TripoTaskMeta = {
  title: string
  submitLabel: string
  description: string
}

type TripoFlowActionOption = {
  value: Hy3dApiAction
  label: string
  hint: string
}

const TRIPO_TASK_META: Partial<Record<Hy3dParams['apiAction'], TripoTaskMeta>> = {
  TripoStylized3DFlow: {
    title: 'Tripo 风格化 3D',
    submitLabel: '生成风格化 3D',
    description: '先按模板生成风格化图片，再自动用该图片生成 3D 模型。'
  },
  TripoTextToImage: {
    title: 'Tripo 文生图',
    submitLabel: '生成图片',
    description: '提交 text_to_image 任务，生成一张概念参考图。'
  },
  TripoGenerateImage: {
    title: 'Tripo 高级生图',
    submitLabel: '生成图片',
    description: '提交 generate_image 任务，可带参考图、模板和图像模型。'
  },
  TripoGenerateMultiviewImage: {
    title: 'Tripo 多视图图',
    submitLabel: '生成多视图',
    description: '提交 generate_multiview_image 任务，由单张参考图生成四视图。'
  },
  TripoEditMultiviewImage: {
    title: 'Tripo 编辑多视图',
    submitLabel: '编辑多视图',
    description: '提交 edit_multiview_image 任务，按视角修改已有多视图任务。'
  },
  TripoImportModel: {
    title: 'Tripo 导入模型',
    submitLabel: '导入模型',
    description: '提交 import_model 任务，支持 Tripo STS file token/object 或公开模型 URL。'
  },
  SubmitTextureTo3DJob: {
    title: 'Tripo 纹理',
    submitLabel: '生成纹理',
    description: '提交 texture_model 任务，基于 Tripo 模型任务继续生成纹理。'
  },
  SubmitHunyuan3DPartJob: {
    title: 'Tripo 分割',
    submitLabel: '开始分割',
    description: '提交 mesh_segmentation 任务，为后续部件补全等流程准备分割结果。'
  },
  TripoMeshCompletion: {
    title: 'Tripo 补全',
    submitLabel: '开始补全',
    description: '提交 mesh_completion 任务，可填写要补全的 part_names，多个名称用逗号分隔。'
  },
  SubmitReduceFaceJob: {
    title: 'Tripo 低模',
    submitLabel: '生成低模',
    description: '提交 highpoly_to_lowpoly 任务，输出更低面数的模型。'
  },
  TripoPreRigCheck: {
    title: 'Tripo 绑定预检',
    submitLabel: '开始预检',
    description: '提交 animate_prerigcheck 任务，检查模型是否适合骨骼绑定。'
  },
  TripoRig: {
    title: 'Tripo 骨骼绑定',
    submitLabel: '开始绑定',
    description: '提交 animate_rig 任务，输出带骨骼的 GLB/FBX 资源。'
  },
  TripoRetarget: {
    title: 'Tripo 动画重定向',
    submitLabel: '生成动画',
    description: '提交 animate_retarget 任务，把预设动画应用到已绑定模型。'
  },
  Convert3DFormat: {
    title: 'Tripo 格式转换',
    submitLabel: '开始转换',
    description: '提交 convert_model 任务，导出 GLTF / USDZ / FBX / OBJ / STL / 3MF。'
  }
}

const TRIPO_FLOW_ACTION_OPTIONS: Partial<Record<string, TripoFlowActionOption[]>> = {
  'image-pipeline': [
    {
      value: 'TripoGenerateImage',
      label: '高级生图',
      hint: '用提示词、参考图和模板生成风格化图片。'
    },
    {
      value: 'TripoTextToImage',
      label: '文生图',
      hint: '只用文字生成概念参考图。'
    },
    {
      value: 'TripoGenerateMultiviewImage',
      label: '多视图',
      hint: '由单张参考图生成 front / left / back / right 多视图。'
    },
    {
      value: 'TripoEditMultiviewImage',
      label: '编辑多视图',
      hint: '基于上一轮多视图 Task ID 修改指定视角。'
    }
  ],
  'model-refine': [
    {
      value: 'TripoImportModel',
      label: '导入',
      hint: '把外部模型导入 Tripo，生成可继续处理的任务。'
    },
    {
      value: 'SubmitTextureTo3DJob',
      label: '纹理',
      hint: '基于上一轮模型 Task ID 继续生成纹理。'
    },
    {
      value: 'SubmitHunyuan3DPartJob',
      label: '分割',
      hint: '对上一轮模型做部件分割。'
    },
    {
      value: 'TripoMeshCompletion',
      label: '补全',
      hint: '对分割后的指定部件做补全。'
    },
    {
      value: 'SubmitReduceFaceJob',
      label: '低模',
      hint: '把上一轮模型转换成更低面数版本。'
    },
    {
      value: 'Convert3DFormat',
      label: '格式',
      hint: '把上一轮模型导出为 GLTF / USDZ / FBX / OBJ / STL / 3MF。'
    }
  ],
  'rig-animation': [
    {
      value: 'TripoPreRigCheck',
      label: '预检',
      hint: '检查上一轮模型是否适合骨骼绑定。'
    },
    {
      value: 'TripoRig',
      label: '绑定',
      hint: '给上一轮模型生成骨骼。'
    },
    {
      value: 'TripoRetarget',
      label: '动画',
      hint: '把预设动画应用到已绑定模型。'
    }
  ]
}

const IMAGE_ACTIONS = new Set<Hy3dParams['apiAction']>([
  'TripoStylized3DFlow',
  'TripoGenerateImage',
  'TripoGenerateMultiviewImage'
])

const PROMPT_ACTIONS = new Set<Hy3dParams['apiAction']>([
  'TripoStylized3DFlow',
  'TripoTextToImage',
  'TripoGenerateImage',
  'TripoEditMultiviewImage'
])

const TASK_ID_REFERENCE_ACTIONS = new Set<Hy3dParams['apiAction']>([
  'TripoEditMultiviewImage',
  'SubmitTextureTo3DJob',
  'SubmitHunyuan3DPartJob',
  'TripoMeshCompletion',
  'SubmitReduceFaceJob',
  'TripoPreRigCheck',
  'TripoRig',
  'TripoRetarget',
  'Convert3DFormat'
])

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Failed to read image.'))
    reader.readAsDataURL(file)
  })

const isTextureAction = (action: Hy3dParams['apiAction']): boolean =>
  action === 'SubmitTextureTo3DJob'

const getImageList = (
  action: Hy3dParams['apiAction'],
  mediaState: Hy3dMediaState
): Hy3dImageAttachment[] =>
  isTextureAction(action) ? mediaState.textureRefImages : mediaState.conceptImages

const TripoTaskPanel: React.FC<TripoTaskPanelProps> = ({
  params,
  mediaState,
  onParamsChange,
  onMediaStateChange,
  onGenerate
}) => {
  const imageInputRef = React.useRef<HTMLInputElement | null>(null)
  const action = params.apiAction
  const meta = TRIPO_TASK_META[action] || {
    title: 'Tripo 任务',
    submitLabel: '执行',
    description: '提交 Tripo 任务。'
  }
  const flowStepId = getTripoWorkflowStepIdForAction(action)
  const flowActionOptions = TRIPO_FLOW_ACTION_OPTIONS[flowStepId] || []
  const activeFlowActionOption = flowActionOptions.find((option) => option.value === action)
  const images = getImageList(action, mediaState)
  const needsPrompt = PROMPT_ACTIONS.has(action)
  const needsImageUpload = IMAGE_ACTIONS.has(action) || isTextureAction(action)
  const isImportModel = action === 'TripoImportModel'
  const isStylizedFlow = action === 'TripoStylized3DFlow'
  const isGenerateImage = action === 'TripoGenerateImage' || isStylizedFlow
  const isMultiviewImage = action === 'TripoGenerateMultiviewImage'
  const isEditMultiview = action === 'TripoEditMultiviewImage'
  const needsTaskIdReference = TASK_ID_REFERENCE_ACTIONS.has(action)
  const isCompletion = action === 'TripoMeshCompletion'
  const isLowpoly = action === 'SubmitReduceFaceJob'
  const isRig = action === 'TripoRig'
  const isRetarget = action === 'TripoRetarget'
  const isConvert = action === 'Convert3DFormat'
  const hasTaskIdReference = Boolean(params.modelTaskId.trim())
  const hasPrompt = Boolean(params.prompt.trim())
  const hasTexturePrompt = Boolean(params.texturePrompt.trim())
  const submitDisabled =
    (needsPrompt && !hasPrompt) ||
    (isStylizedFlow && images.length === 0) ||
    (isMultiviewImage && images.length === 0) ||
    (isImportModel && !params.modelUrl.trim()) ||
    (needsTaskIdReference && !hasTaskIdReference) ||
    (isTextureAction(action) && !hasTexturePrompt && images.length === 0)

  const updateImageList = React.useCallback(
    (nextImages: Hy3dImageAttachment[]) => {
      if (isTextureAction(action)) {
        onMediaStateChange({ textureRefImages: nextImages })
      } else {
        onMediaStateChange({ conceptImages: nextImages })
      }
    },
    [action, onMediaStateChange]
  )

  const handleImageFiles = React.useCallback(
    async (fileList: FileList | null) => {
      const files = Array.from(fileList || []).filter((file) => file.type.startsWith('image/'))
      if (files.length === 0) return

      const nextImages = await Promise.all(
        files.map(async (file, index) => ({
          type: 'image' as const,
          url: await readFileAsDataUrl(file),
          mimeType: file.type,
          fileName: file.name,
          slot: index === 0 ? 'single' : undefined
        }))
      )

      updateImageList(isMultiviewImage || isStylizedFlow ? nextImages.slice(0, 1) : nextImages)
      if (isTextureAction(action)) {
        onParamsChange({ texturePrompt: '' })
      }
    },
    [action, isMultiviewImage, isStylizedFlow, onParamsChange, updateImageList]
  )

  const handleImageRemove = React.useCallback(
    (index: number) => {
      updateImageList(images.filter((_, itemIndex) => itemIndex !== index))
    },
    [images, updateImageList]
  )

  return (
    <PanelShell
      title={meta.title}
      submitLabel={meta.submitLabel}
      submitDisabled={submitDisabled}
      submitIcon="sparkle"
      onSubmit={onGenerate}
    >
      <TipBanner>{meta.description}</TipBanner>

      {flowActionOptions.length > 1 && (
        <>
          <SectionLabel info="这些是当前流程里的连续环节。上一步返回的 Task ID 会自动留在这里，供下一步继续处理。">
            当前环节
          </SectionLabel>
          <ParamSegment
            options={flowActionOptions.map((option) => ({
              value: option.value,
              label: option.label
            }))}
            value={action}
            onChange={(value) => onParamsChange({ apiAction: value as Hy3dApiAction })}
          />
          {activeFlowActionOption && (
            <Typography
              sx={{
                mt: 0.9,
                fontSize: 12,
                color: hyColors.textSecondary,
                lineHeight: 1.5
              }}
            >
              {activeFlowActionOption.hint}
            </Typography>
          )}
        </>
      )}

      {needsTaskIdReference && (
        <>
          <SectionLabel info="Tripo 任务完成后会返回 Task ID。继续处理该结果时需要这个 ID，通常会从上一步自动带入。">
            {isEditMultiview ? '多视图任务 ID' : '上一轮 Tripo 任务 ID'}
          </SectionLabel>
          <TextField
            fullWidth
            size="small"
            value={params.modelTaskId}
            placeholder="从上一次输出的 [Tripo3D] Task ID 复制，通常会自动带入"
            onChange={(event) => onParamsChange({ modelTaskId: event.target.value })}
            helperText={
              isEditMultiview
                ? '编辑多视图需要 generate_multiview_image 返回的 Task ID。'
                : '不是 API Key。它是上一步生成/导入模型后返回的任务 ID。'
            }
          />
        </>
      )}

      {isImportModel && (
        <>
          <SectionLabel info="可填写 tripo-file-token:<token>、file_token:<token>、完整 file object JSON，或公开可访问的模型 URL。">
            模型 file token / URL
          </SectionLabel>
          <TextField
            fullWidth
            multiline
            minRows={3}
            size="small"
            value={params.modelUrl}
            placeholder='tripo-file-token:... 或 {"type":"model","file_token":"..."}'
            onChange={(event) =>
              onParamsChange({
                modelUrl: event.target.value,
                modelSourceFileName: ''
              })
            }
          />
        </>
      )}

      {needsPrompt && (
        <>
          <SectionLabel>
            {isEditMultiview ? '编辑提示词' : isStylizedFlow ? '风格化提示词' : '提示词'}
          </SectionLabel>
          <TextField
            fullWidth
            multiline
            minRows={4}
            size="small"
            value={params.prompt}
            placeholder={
              isStylizedFlow ? '描述源图要套用的风格、材质或造型方向' : '描述要生成或修改的内容'
            }
            onChange={(event) => onParamsChange({ prompt: event.target.value })}
          />
        </>
      )}

      {isGenerateImage && (
        <>
          <SectionLabel>图像模型</SectionLabel>
          <TextField
            select
            fullWidth
            size="small"
            value={params.tripoImageModelVersion}
            onChange={(event) => onParamsChange({ tripoImageModelVersion: event.target.value })}
          >
            {TRIPO_IMAGE_MODEL_VERSION_OPTIONS.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>

          <SectionLabel>模板</SectionLabel>
          <ParamSegment
            options={TRIPO_TEMPLATE_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label
            }))}
            value={params.tripoImageTemplate}
            onChange={(value) => onParamsChange({ tripoImageTemplate: value })}
          />
        </>
      )}

      {isEditMultiview && (
        <>
          <SectionLabel>编辑视角</SectionLabel>
          <ParamSegment
            options={[
              { value: 'front', label: 'Front' },
              { value: 'left', label: 'Left' },
              { value: 'back', label: 'Back' },
              { value: 'right', label: 'Right' }
            ]}
            value={params.tripoEditView}
            onChange={(value) =>
              onParamsChange({ tripoEditView: value as Hy3dParams['tripoEditView'] })
            }
          />
        </>
      )}

      {(isTextureAction(action) || isCompletion) && (
        <>
          <SectionLabel>
            {isTextureAction(action) ? '纹理描述 / part_names' : 'part_names（可选）'}
          </SectionLabel>
          <TextField
            fullWidth
            multiline
            minRows={isTextureAction(action) ? 3 : 2}
            size="small"
            value={params.texturePrompt}
            placeholder={
              isTextureAction(action)
                ? '例如 weathered bronze, hand-painted stylized stone'
                : '例如 head, left_arm, backpack'
            }
            onChange={(event) => onParamsChange({ texturePrompt: event.target.value })}
            disabled={isTextureAction(action) && images.length > 0}
          />
        </>
      )}

      {needsImageUpload && (
        <>
          <SectionLabel
            info={
              isTextureAction(action)
                ? '上传参考图后会清空纹理文字描述。'
                : isStylizedFlow
                  ? '必须上传一张源图。Tripo 会先按提示词和模板生成风格化图片，再自动生成 3D 模型。'
                  : isMultiviewImage
                    ? '仅需要一张源图，Tripo 会生成 front / left / back / right 多视图。'
                    : '可选参考图。单图会作为 file，多图会作为 files 提交。'
            }
          >
            {isTextureAction(action) ? '纹理参考图' : isStylizedFlow ? '源图' : '参考图'}
          </SectionLabel>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple={!isMultiviewImage && !isStylizedFlow}
            hidden
            onChange={(event) => {
              void handleImageFiles(event.target.files)
              event.target.value = ''
            }}
          />
          <Button
            variant="outlined"
            size="small"
            startIcon={<AddPhotoAlternateOutlinedIcon />}
            onClick={() => imageInputRef.current?.click()}
          >
            选择图片
          </Button>

          {images.length > 0 && (
            <Stack direction="row" spacing={1} sx={{ mt: 1.25, flexWrap: 'wrap' }}>
              {images.map((image, index) => (
                <Box
                  key={`${image.url}-${index}`}
                  sx={{
                    position: 'relative',
                    width: 72,
                    height: 72,
                    borderRadius: '8px',
                    overflow: 'hidden',
                    border: `1px solid ${hyColors.softBorder}`,
                    bgcolor: hyColors.softBgStrong
                  }}
                >
                  <Box
                    component="img"
                    src={image.url}
                    alt={image.fileName || `reference-${index + 1}`}
                    sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  />
                  <IconButton
                    size="small"
                    aria-label="移除图片"
                    onClick={() => handleImageRemove(index)}
                    sx={{
                      position: 'absolute',
                      top: 3,
                      right: 3,
                      width: 24,
                      height: 24,
                      color: '#fff',
                      bgcolor: 'rgba(0,0,0,0.58)',
                      '&:hover': { bgcolor: 'rgba(0,0,0,0.74)' }
                    }}
                  >
                    <DeleteOutlineIcon sx={{ fontSize: 15 }} />
                  </IconButton>
                </Box>
              ))}
            </Stack>
          )}
        </>
      )}

      {isLowpoly && (
        <>
          <SectionLabel>目标面数等级</SectionLabel>
          <ParamSegment
            options={FACE_LEVEL_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label
            }))}
            value={params.topoFaceLevel || 'low'}
            onChange={(value) =>
              onParamsChange({ topoFaceLevel: value as Hy3dParams['topoFaceLevel'] })
            }
          />
        </>
      )}

      {(isLowpoly || isConvert) && (
        <>
          <SectionLabel>多边形类型</SectionLabel>
          <ParamSegment
            options={POLYGON_TYPE_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label
            }))}
            value={params.polygonType}
            onChange={(value) =>
              onParamsChange({ polygonType: value as Hy3dParams['polygonType'] })
            }
          />
        </>
      )}

      {isConvert && (
        <>
          <SectionLabel>目标格式</SectionLabel>
          <ParamSegment
            options={TRIPO_CONVERT_TARGET_FORMATS.map((format) => ({
              value: format.value,
              label: format.label
            }))}
            value={params.convertTargetFormat}
            onChange={(value) =>
              onParamsChange({ convertTargetFormat: value as Hy3dParams['convertTargetFormat'] })
            }
          />
        </>
      )}

      {isRig && (
        <>
          <SectionLabel>绑定类型</SectionLabel>
          <ParamSegment
            options={TRIPO_RIG_TYPE_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label
            }))}
            value={params.tripoRigType}
            onChange={(value) => onParamsChange({ tripoRigType: value })}
          />

          <SectionLabel>绑定规格</SectionLabel>
          <ParamSegment
            options={TRIPO_RIG_SPEC_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label
            }))}
            value={params.tripoRigSpec}
            onChange={(value) => onParamsChange({ tripoRigSpec: value })}
          />
        </>
      )}

      {isRetarget && (
        <>
          <SectionLabel>动画预设</SectionLabel>
          <TextField
            select
            fullWidth
            size="small"
            value={params.tripoAnimationPreset}
            onChange={(event) => onParamsChange({ tripoAnimationPreset: event.target.value })}
          >
            {TRIPO_ANIMATION_PRESETS.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
        </>
      )}

      {isTextureAction(action) && (
        <>
          <SectionLabel info={PBR_MATERIAL_INFO}>PBR 材质</SectionLabel>
          <Switch
            checked={params.textureEnablePBR}
            onChange={(_, checked) => onParamsChange({ textureEnablePBR: checked })}
            sx={hySwitchSx}
          />
        </>
      )}

      {submitDisabled && (
        <Typography sx={{ mt: 2, fontSize: 11.5, color: hyColors.textSecondary }}>
          请补齐当前任务必需的输入后再执行。
        </Typography>
      )}
    </PanelShell>
  )
}

export default TripoTaskPanel
