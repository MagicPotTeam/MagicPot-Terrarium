import React from 'react'
import { Box, IconButton, Switch, TextField, Typography } from '@mui/material'
import AddPhotoAlternateOutlinedIcon from '@mui/icons-material/AddPhotoAlternateOutlined'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import PanelShell from './PanelShell'
import ModelDropZone from './ModelDropZone'
import { PBR_MATERIAL_INFO, ParamSegment, SectionLabel, TipBanner } from './ui'
import { hyColors, hySwitchSx } from './theme'
import type { Hy3dImageAttachment, Hy3dMediaState, Hy3dParams } from './types'
import {
  MULTI_VIEW_SLOTS,
  TEXTURE_MODEL_EXTENSIONS,
  TEXTURE_PROMPT_MAX_LENGTH,
  getHy3dPostProcessModelCompatibility,
  sortHy3dConceptImages
} from './types'
import { getDroppedImageFile, hasDroppedImageData } from './imageDrop'
import { useImagePasteTarget } from './useImagePasteTarget'

interface TexturePanelProps {
  params: Hy3dParams
  mediaState: Hy3dMediaState
  onParamsChange: (p: Partial<Hy3dParams>) => void
  onMediaStateChange: (state: Partial<Hy3dMediaState>) => void
  onGenerate?: () => void
}

const toImageAttachment = async (
  file: File,
  fileName: string,
  slot?: string
): Promise<Hy3dImageAttachment> => {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Failed to read image'))
    reader.readAsDataURL(file)
  })

  return {
    type: 'image',
    url,
    fileName,
    mimeType: file.type || 'image/png',
    slot
  }
}

const TexturePanel: React.FC<TexturePanelProps> = ({
  params,
  mediaState,
  onParamsChange,
  onMediaStateChange,
  onGenerate
}) => {
  const texturePrompt = params.texturePrompt || ''
  const textureEnablePBR = params.textureEnablePBR ?? false
  const textureRefImages = mediaState.textureRefImages
  const modelCompatibility = getHy3dPostProcessModelCompatibility('SubmitTextureTo3DJob', params)
  const [isPrimaryDragOver, setIsPrimaryDragOver] = React.useState(false)
  const [multiViewDragOverSlot, setMultiViewDragOverSlot] = React.useState<string | null>(null)

  const primaryTextureRefImage =
    textureRefImages.find((item) => item.slot === 'single') || textureRefImages[0] || null
  const textureMultiViewImages = React.useMemo(() => {
    const entries = textureRefImages
      .filter((item) => item.slot && item.slot !== 'single')
      .map((item) => [item.slot as string, item] as const)
    return Object.fromEntries(entries)
  }, [textureRefImages])
  const availableTextureMultiViewSlots = React.useMemo(
    () =>
      MULTI_VIEW_SLOTS.filter(
        (slot) =>
          slot.apiKey !== 'front' && (!slot.minVersion || slot.minVersion <= params.modelVersion)
      ),
    [params.modelVersion]
  )

  const updateTextureRefImages = React.useCallback(
    (nextImages: Hy3dImageAttachment[]) =>
      onMediaStateChange({ textureRefImages: sortHy3dConceptImages(nextImages) }),
    [onMediaStateChange]
  )

  React.useEffect(() => {
    if (!primaryTextureRefImage || primaryTextureRefImage.slot === 'single') return

    const remainingImages = textureRefImages.filter((item) => item !== primaryTextureRefImage)
    updateTextureRefImages([{ ...primaryTextureRefImage, slot: 'single' }, ...remainingImages])
  }, [primaryTextureRefImage, textureRefImages, updateTextureRefImages])

  React.useEffect(() => {
    if (params.modelVersion === '3.1') return

    const extraImages = textureRefImages.filter((item) => item.slot && item.slot !== 'single')
    if (extraImages.length === 0) return

    updateTextureRefImages(
      primaryTextureRefImage ? [{ ...primaryTextureRefImage, slot: 'single' }] : []
    )
  }, [params.modelVersion, primaryTextureRefImage, textureRefImages, updateTextureRefImages])

  const pickImage = React.useCallback(async (onPicked: (file: File) => Promise<void>) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async (event: Event) => {
      const file = (event.target as HTMLInputElement).files?.[0]
      if (file) {
        await onPicked(file)
      }
    }
    input.click()
  }, [])

  const applyPrimaryTextureRefFile = React.useCallback(
    async (file: File) => {
      const image = await toImageAttachment(file, file.name, 'single')
      const remainingImages = textureRefImages.filter((item) => item.slot && item.slot !== 'single')
      onParamsChange({ texturePrompt: '' })
      updateTextureRefImages([image, ...remainingImages])
    },
    [onParamsChange, textureRefImages, updateTextureRefImages]
  )

  const handlePrimaryTextureRefUpload = React.useCallback(() => {
    void pickImage(async (file) => {
      await applyPrimaryTextureRefFile(file)
    })
  }, [applyPrimaryTextureRefFile, pickImage])

  const handlePrimaryTextureRefDragOver = React.useCallback((event: React.DragEvent) => {
    if (!hasDroppedImageData(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    setIsPrimaryDragOver(true)
  }, [])

  const handlePrimaryTextureRefDragLeave = React.useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setIsPrimaryDragOver(false)
  }, [])

  const handlePrimaryTextureRefDrop = React.useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
      setIsPrimaryDragOver(false)

      const file = await getDroppedImageFile(event.dataTransfer)
      if (!file) return

      await applyPrimaryTextureRefFile(file)
    },
    [applyPrimaryTextureRefFile]
  )

  const applyTextureMultiViewFile = React.useCallback(
    async (apiKey: string, file: File) => {
      if (!primaryTextureRefImage) return

      const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '.png'
      const image = await toImageAttachment(file, `${apiKey}${ext}`, apiKey)
      const remainingImages = textureRefImages.filter(
        (item) => item.slot && item.slot !== 'single' && item.slot !== apiKey
      )
      onParamsChange({ texturePrompt: '' })
      updateTextureRefImages([
        { ...primaryTextureRefImage, slot: 'single' },
        ...remainingImages,
        image
      ])
    },
    [onParamsChange, primaryTextureRefImage, textureRefImages, updateTextureRefImages]
  )

  const handleTextureMultiViewUpload = React.useCallback(
    (apiKey: string) => {
      if (!primaryTextureRefImage) return
      void pickImage(async (file) => {
        await applyTextureMultiViewFile(apiKey, file)
      })
    },
    [applyTextureMultiViewFile, pickImage, primaryTextureRefImage]
  )

  const handleTextureMultiViewRemove = React.useCallback(
    (apiKey: string) => {
      updateTextureRefImages(textureRefImages.filter((item) => item.slot !== apiKey))
    },
    [textureRefImages, updateTextureRefImages]
  )

  const handleTextureMultiViewDragOver = React.useCallback(
    (apiKey: string, event: React.DragEvent) => {
      if (!primaryTextureRefImage || !hasDroppedImageData(event.dataTransfer)) return
      event.preventDefault()
      event.stopPropagation()
      setMultiViewDragOverSlot(apiKey)
    },
    [primaryTextureRefImage]
  )

  const handleTextureMultiViewDragLeave = React.useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setMultiViewDragOverSlot(null)
  }, [])

  const handleTextureMultiViewDrop = React.useCallback(
    async (apiKey: string, event: React.DragEvent) => {
      if (!primaryTextureRefImage) return
      event.preventDefault()
      event.stopPropagation()
      setMultiViewDragOverSlot(null)

      const file = await getDroppedImageFile(event.dataTransfer)
      if (!file) return

      await applyTextureMultiViewFile(apiKey, file)
    },
    [applyTextureMultiViewFile, primaryTextureRefImage]
  )

  const { getPasteTargetProps } = useImagePasteTarget({
    onPasteImage: async (targetId, file) => {
      if (targetId === 'primary') {
        await applyPrimaryTextureRefFile(file)
        return
      }

      if (!primaryTextureRefImage) return
      await applyTextureMultiViewFile(targetId, file)
    }
  })

  return (
    <PanelShell
      title="纹理绘制"
      submitLabel="开始生成纹理"
      submitDisabled={
        !params.modelUrl ||
        (!texturePrompt && !primaryTextureRefImage) ||
        modelCompatibility.status === 'incompatible'
      }
      onSubmit={onGenerate}
    >
      <TipBanner>
        官方纹理接口仅接受公开可访问的 OBJ / GLB 模型链接，并且 Prompt
        与参考图只能二选一。纹理模型支持 `3.0 / 3.1`，其中 `3.1` 额外支持多视图参考图。
      </TipBanner>
      {modelCompatibility.status === 'incompatible' && (
        <Typography sx={{ mt: 1, fontSize: 11.5, color: '#ffb15e' }}>
          当前模型格式看起来是 {modelCompatibility.inferredFormat}，纹理绘制只接受{' '}
          {modelCompatibility.acceptedFormats.join(' / ')}。请重新选择模型。
        </Typography>
      )}

      <ModelDropZone
        value={params.modelUrl || ''}
        onChange={(value) => onParamsChange({ modelUrl: value })}
        fileName={params.modelSourceFileName || ''}
        storageMeta={{
          sourceFileName: params.modelSourceFileName,
          storageKey: params.modelStorageKey,
          storageBucket: params.modelStorageBucket,
          storageRegion: params.modelStorageRegion,
          signedUrlExpiresAt: params.modelSignedUrlExpiresAt
        }}
        onMetaChange={(meta) =>
          onParamsChange({
            modelSourceFileName: meta.sourceFileName,
            modelStorageKey: meta.storageKey,
            modelStorageBucket: meta.storageBucket,
            modelStorageRegion: meta.storageRegion,
            modelSignedUrlExpiresAt: meta.signedUrlExpiresAt
          })
        }
        label="源模型 URL"
        acceptExtensions={TEXTURE_MODEL_EXTENSIONS}
        allowedFormatsLabel="OBJ / GLB"
        urlOnly
        enableLocalUpload
      />

      <SectionLabel>纹理模型版本</SectionLabel>
      <ParamSegment
        options={[
          { value: '3.1', label: 'V3.1' },
          { value: '3.0', label: 'V3.0' }
        ]}
        value={params.modelVersion}
        onChange={(value) => onParamsChange({ modelVersion: value as Hy3dParams['modelVersion'] })}
      />

      <SectionLabel info="最多 200 个 UTF-8 字符；上传参考图后将自动清空。">纹理描述</SectionLabel>
      <TextField
        multiline
        fullWidth
        minRows={3}
        maxRows={5}
        placeholder="例如：深色金属机甲表面，边缘有磨损与轻微发光细节"
        value={texturePrompt}
        onChange={(event) => {
          if (event.target.value.length <= TEXTURE_PROMPT_MAX_LENGTH) {
            if (textureRefImages.length > 0 && event.target.value) {
              onMediaStateChange({ textureRefImages: [] })
            }
            onParamsChange({ texturePrompt: event.target.value })
          }
        }}
        sx={{
          '& .MuiOutlinedInput-root': {
            bgcolor: hyColors.card,
            color: hyColors.textPrimary,
            fontSize: 13,
            borderRadius: '10px',
            '& fieldset': { borderColor: 'transparent' },
            '&:hover': { bgcolor: hyColors.cardHover },
            '&.Mui-focused fieldset': { borderColor: hyColors.primary, borderWidth: '1px' }
          },
          '& .MuiInputBase-input': {
            '&::placeholder': { color: hyColors.inputPlaceholder, opacity: 1 }
          }
        }}
      />
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.5, px: 0.5 }}>
        <Typography sx={{ fontSize: 11, color: hyColors.textSecondary }}>
          {texturePrompt.length}/{TEXTURE_PROMPT_MAX_LENGTH}
        </Typography>
      </Box>

      <SectionLabel info="上传主参考图后会清空 Prompt。">主参考图（可选）</SectionLabel>
      {primaryTextureRefImage ? (
        <Box
          onDragOver={handlePrimaryTextureRefDragOver}
          onDragLeave={handlePrimaryTextureRefDragLeave}
          onDrop={(event) => void handlePrimaryTextureRefDrop(event)}
          {...getPasteTargetProps('primary')}
          sx={{
            position: 'relative',
            width: '100%',
            borderRadius: '10px',
            overflow: 'hidden',
            border: `1px solid ${isPrimaryDragOver ? hyColors.primaryHover : hyColors.softBorder}`,
            bgcolor: hyColors.card,
            mb: 2,
            outline: 'none'
          }}
        >
          <Box
            component="img"
            src={primaryTextureRefImage.url}
            alt="纹理主参考图"
            sx={{ width: '100%', maxHeight: 160, objectFit: 'contain', display: 'block' }}
          />
          <Box sx={{ position: 'absolute', top: 6, right: 6, display: 'flex', gap: 0.75 }}>
            <IconButton
              size="small"
              onClick={handlePrimaryTextureRefUpload}
              sx={{ bgcolor: 'rgba(0,0,0,0.6)', color: '#f5f5f5', width: 26, height: 26 }}
            >
              <AddPhotoAlternateOutlinedIcon sx={{ fontSize: 15 }} />
            </IconButton>
            <IconButton
              size="small"
              onClick={() => updateTextureRefImages([])}
              sx={{ bgcolor: 'rgba(0,0,0,0.6)', color: '#ff4d4f', width: 26, height: 26 }}
            >
              <DeleteOutlineIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Box>
        </Box>
      ) : (
        <Box
          onClick={handlePrimaryTextureRefUpload}
          onDragOver={handlePrimaryTextureRefDragOver}
          onDragLeave={handlePrimaryTextureRefDragLeave}
          onDrop={(event) => void handlePrimaryTextureRefDrop(event)}
          {...getPasteTargetProps('primary')}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            py: 2,
            borderRadius: '10px',
            border: `1.5px dashed ${
              isPrimaryDragOver ? hyColors.primaryHover : hyColors.dashedBorder
            }`,
            bgcolor: isPrimaryDragOver ? hyColors.softHoverBg : hyColors.softBg,
            cursor: 'pointer',
            mb: 2,
            outline: 'none',
            '&:hover': { borderColor: hyColors.softHoverBorder, bgcolor: hyColors.softHoverBg }
          }}
        >
          <AddPhotoAlternateOutlinedIcon sx={{ fontSize: 20, color: hyColors.mutedIcon }} />
          <Typography sx={{ fontSize: 12, color: hyColors.textSecondary }}>上传主参考图</Typography>
        </Box>
      )}

      {params.modelVersion === '3.1' && (
        <>
          <SectionLabel info="先上传主参考图，再补充不同视角的多视图图片。">
            多视图参考图（可选）
          </SectionLabel>
          {!primaryTextureRefImage ? (
            <Typography sx={{ mb: 2, fontSize: 11.5, color: hyColors.textSecondary }}>
              `3.1` 支持左 / 右 / 后，以及顶视、底视和左右前 45°。请先上传主参考图。
            </Typography>
          ) : (
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                gap: 1,
                mb: 2
              }}
            >
              {availableTextureMultiViewSlots.map((slot) => {
                const image = textureMultiViewImages[slot.apiKey]
                const isDragOver = multiViewDragOverSlot === slot.apiKey
                return (
                  <Box key={slot.id}>
                    <Typography sx={{ mb: 0.5, fontSize: 11, color: hyColors.textSecondary }}>
                      {slot.label}
                    </Typography>
                    <Box
                      onClick={() => !image && handleTextureMultiViewUpload(slot.apiKey)}
                      onDragOver={(event) => handleTextureMultiViewDragOver(slot.apiKey, event)}
                      onDragLeave={handleTextureMultiViewDragLeave}
                      onDrop={(event) => void handleTextureMultiViewDrop(slot.apiKey, event)}
                      {...getPasteTargetProps(slot.apiKey, {
                        disabled: !primaryTextureRefImage
                      })}
                      sx={{
                        position: 'relative',
                        width: '100%',
                        aspectRatio: '1 / 1',
                        borderRadius: '12px',
                        overflow: 'hidden',
                        border: image
                          ? `1px solid ${hyColors.softBorder}`
                          : `1.5px dashed ${
                              isDragOver ? hyColors.primaryHover : hyColors.dashedBorder
                            }`,
                        bgcolor: image
                          ? hyColors.card
                          : isDragOver
                            ? hyColors.softHoverBg
                            : hyColors.softBg,
                        cursor: image ? 'default' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        outline: 'none',
                        '&:hover': image
                          ? undefined
                          : {
                              borderColor: hyColors.softHoverBorder,
                              bgcolor: hyColors.softHoverBg
                            }
                      }}
                    >
                      {image ? (
                        <>
                          <Box
                            component="img"
                            src={image.url}
                            alt={slot.label}
                            sx={{
                              width: '100%',
                              height: '100%',
                              objectFit: 'contain',
                              display: 'block'
                            }}
                          />
                          <Box sx={{ position: 'absolute', top: 6, right: 6 }}>
                            <IconButton
                              size="small"
                              onClick={(event) => {
                                event.stopPropagation()
                                handleTextureMultiViewRemove(slot.apiKey)
                              }}
                              sx={{ color: '#ff4d4f', bgcolor: 'rgba(0,0,0,0.6)' }}
                            >
                              <DeleteOutlineIcon sx={{ fontSize: 15 }} />
                            </IconButton>
                          </Box>
                        </>
                      ) : (
                        <Box sx={{ textAlign: 'center', px: 1.5 }}>
                          <AddPhotoAlternateOutlinedIcon
                            sx={{ fontSize: 18, color: hyColors.mutedIcon, mb: 0.5 }}
                          />
                          <Typography sx={{ fontSize: 11.5, color: hyColors.textSecondary }}>
                            添加 {slot.label}
                          </Typography>
                        </Box>
                      )}
                    </Box>
                  </Box>
                )
              })}
            </Box>
          )}
        </>
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 1 }}>
        <SectionLabel info={PBR_MATERIAL_INFO}>PBR 材质</SectionLabel>
        <Switch
          checked={textureEnablePBR}
          onChange={(_, checked) => onParamsChange({ textureEnablePBR: checked })}
          size="small"
          sx={hySwitchSx}
        />
      </Box>
      <Typography sx={{ mt: 0.35, fontSize: 11.5, color: hyColors.textSecondary }}>
        {PBR_MATERIAL_INFO}
      </Typography>
    </PanelShell>
  )
}

export default TexturePanel
