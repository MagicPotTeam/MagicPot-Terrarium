import React from 'react'
import { Box, Collapse, IconButton, Switch, TextField, Typography } from '@mui/material'
import AddPhotoAlternateOutlinedIcon from '@mui/icons-material/AddPhotoAlternateOutlined'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import PanelShell from './PanelShell'
import { PBR_MATERIAL_INFO, ParamSegment, SectionLabel, TopTabs } from './ui'
import { hyColors, hySwitchSx } from './theme'
import type { Hy3dImageAttachment, Hy3dMediaState, Hy3dMode, Hy3dParams } from './types'
import { getDroppedImageFile, hasDroppedImageData } from './imageDrop'
import { useImagePasteTarget } from './useImagePasteTarget'
import {
  FACE_COUNT_PRESETS,
  MULTI_VIEW_SLOTS,
  POLYGON_TYPE_OPTIONS,
  PRO_GENERATE_TYPES_V30,
  PRO_GENERATE_TYPES_V31,
  PRO_PROMPT_MAX_LENGTH,
  PRO_TARGET_FORMATS,
  RAPID_GENERATE_TYPES,
  RAPID_GEOMETRY_TARGET_FORMATS,
  RAPID_PROMPT_MAX_LENGTH,
  RAPID_TARGET_FORMATS,
  sortHy3dConceptImages
} from './types'

interface ConceptPanelProps {
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

const ConceptPanel: React.FC<ConceptPanelProps> = ({
  params,
  mediaState,
  onParamsChange,
  onMediaStateChange,
  onGenerate
}) => {
  const [imgSubMode, setImgSubMode] = React.useState<'single' | 'multi'>(() =>
    mediaState.conceptImages.some((item) => item.slot && item.slot !== 'single')
      ? 'multi'
      : 'single'
  )
  const [advancedOpen, setAdvancedOpen] = React.useState(false)
  const [singleViewDragOver, setSingleViewDragOver] = React.useState(false)
  const [multiViewDragOverSlot, setMultiViewDragOverSlot] = React.useState<string | null>(null)

  const conceptImages = mediaState.conceptImages
  const singleViewImage = conceptImages.find((item) => item.slot === 'single') || null
  const multiViewImages = React.useMemo(() => {
    const entries = conceptImages
      .filter((item) => item.slot && item.slot !== 'single')
      .map((item) => [item.slot as string, item] as const)
    return Object.fromEntries(entries)
  }, [conceptImages])

  const isRapidMode = params.apiAction === 'SubmitHunyuanTo3DRapidJob'
  const promptMaxLength = isRapidMode ? RAPID_PROMPT_MAX_LENGTH : PRO_PROMPT_MAX_LENGTH

  const availableSlots = React.useMemo(
    () =>
      MULTI_VIEW_SLOTS.filter((slot) => !slot.minVersion || slot.minVersion <= params.modelVersion),
    [params.modelVersion]
  )

  const generateTypeOptions = React.useMemo(() => {
    if (isRapidMode) return RAPID_GENERATE_TYPES
    return params.modelVersion === '3.1' ? PRO_GENERATE_TYPES_V31 : PRO_GENERATE_TYPES_V30
  }, [isRapidMode, params.modelVersion])

  const targetFormatOptions = React.useMemo(() => {
    if (!isRapidMode) return PRO_TARGET_FORMATS
    return params.generateType === 'Geometry' ? RAPID_GEOMETRY_TARGET_FORMATS : RAPID_TARGET_FORMATS
  }, [isRapidMode, params.generateType])

  const uploadedCount = availableSlots.filter((slot) => multiViewImages[slot.apiKey]).length

  const updateConceptImages = React.useCallback(
    (nextImages: Hy3dImageAttachment[]) => onMediaStateChange({ conceptImages: nextImages }),
    [onMediaStateChange]
  )

  React.useEffect(() => {
    if (!isRapidMode) return

    if (imgSubMode !== 'single') {
      setImgSubMode('single')
    }

    const nonSingleImage = conceptImages.find((item) => item.slot && item.slot !== 'single')
    if (nonSingleImage || conceptImages.length > 1) {
      const nextSingleImage = singleViewImage || conceptImages[0] || null
      updateConceptImages(nextSingleImage ? [{ ...nextSingleImage, slot: 'single' }] : [])
    }
  }, [conceptImages, imgSubMode, isRapidMode, singleViewImage, updateConceptImages])

  React.useEffect(() => {
    if (isRapidMode && !['Normal', 'Geometry'].includes(params.generateType)) {
      onParamsChange({ generateType: 'Normal' })
      return
    }

    if (!isRapidMode && params.modelVersion === '3.1' && params.generateType === 'LowPoly') {
      onParamsChange({ generateType: 'Normal' })
    }
  }, [isRapidMode, onParamsChange, params.generateType, params.modelVersion])

  React.useEffect(() => {
    const validTargetValues = targetFormatOptions.map((item) => item.value)
    if (!validTargetValues.includes(params.targetFormat)) {
      onParamsChange({ targetFormat: 'DEFAULT' })
    }
  }, [onParamsChange, params.targetFormat, targetFormatOptions])

  const pickImage = React.useCallback(async (onPicked: (file: File) => Promise<void>) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async (event: Event) => {
      const target = event.target as HTMLInputElement
      const file = target.files?.[0]
      if (file) {
        await onPicked(file)
      }
    }
    input.click()
  }, [])

  const applySingleViewFile = React.useCallback(
    async (file: File) => {
      const image = await toImageAttachment(file, file.name, 'single')
      updateConceptImages([image])
    },
    [updateConceptImages]
  )

  const handleSingleViewUpload = React.useCallback(() => {
    void pickImage(async (file) => {
      await applySingleViewFile(file)
    })
  }, [applySingleViewFile, pickImage])

  const handleSingleViewRemove = React.useCallback(() => {
    updateConceptImages(conceptImages.filter((item) => item.slot !== 'single'))
  }, [conceptImages, updateConceptImages])

  const handleSingleViewDragOver = React.useCallback((event: React.DragEvent) => {
    if (!hasDroppedImageData(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    setSingleViewDragOver(true)
  }, [])

  const handleSingleViewDragLeave = React.useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setSingleViewDragOver(false)
  }, [])

  const handleSingleViewDrop = React.useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
      setSingleViewDragOver(false)

      const file = await getDroppedImageFile(event.dataTransfer)
      if (!file) return

      await applySingleViewFile(file)
    },
    [applySingleViewFile]
  )

  const applyMultiViewFile = React.useCallback(
    async (apiKey: string, file: File) => {
      const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '.png'
      const image = await toImageAttachment(file, `${apiKey}${ext}`, apiKey)
      const remaining = conceptImages.filter(
        (item) => item.slot !== 'single' && item.slot !== apiKey
      )
      updateConceptImages(sortHy3dConceptImages([...remaining, image]))
    },
    [conceptImages, updateConceptImages]
  )

  const handleMultiViewUpload = React.useCallback(
    (apiKey: string) => {
      void pickImage(async (file) => {
        await applyMultiViewFile(apiKey, file)
      })
    },
    [applyMultiViewFile, pickImage]
  )

  const handleMultiViewRemove = React.useCallback(
    (apiKey: string) => {
      updateConceptImages(conceptImages.filter((item) => item.slot !== apiKey))
    },
    [conceptImages, updateConceptImages]
  )

  const handleMultiViewDragOver = React.useCallback((apiKey: string, event: React.DragEvent) => {
    if (!hasDroppedImageData(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    setMultiViewDragOverSlot(apiKey)
  }, [])

  const handleMultiViewDragLeave = React.useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setMultiViewDragOverSlot(null)
  }, [])

  const handleMultiViewDrop = React.useCallback(
    async (apiKey: string, event: React.DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
      setMultiViewDragOverSlot(null)

      const file = await getDroppedImageFile(event.dataTransfer)
      if (!file) return

      await applyMultiViewFile(apiKey, file)
    },
    [applyMultiViewFile]
  )

  const { getPasteTargetProps } = useImagePasteTarget({
    onPasteImage: async (targetId, file) => {
      if (targetId === 'single') {
        await applySingleViewFile(file)
        return
      }

      await applyMultiViewFile(targetId, file)
    }
  })

  const setPipelineAction = React.useCallback(
    (value: string) => {
      const nextRapid = value === 'rapid'
      const nextTargetFormats =
        nextRapid && params.generateType === 'Geometry'
          ? RAPID_GEOMETRY_TARGET_FORMATS
          : nextRapid
            ? RAPID_TARGET_FORMATS
            : PRO_TARGET_FORMATS
      const nextTargetFormat = nextTargetFormats.some((item) => item.value === params.targetFormat)
        ? params.targetFormat
        : 'DEFAULT'

      onParamsChange({
        apiAction: nextRapid ? 'SubmitHunyuanTo3DRapidJob' : 'SubmitHunyuanTo3DProJob',
        generateType:
          nextRapid && !['Normal', 'Geometry'].includes(params.generateType)
            ? 'Normal'
            : params.generateType,
        targetFormat: nextTargetFormat
      })

      if (nextRapid) {
        const nextSingleImage = singleViewImage || conceptImages[0] || null
        updateConceptImages(nextSingleImage ? [{ ...nextSingleImage, slot: 'single' }] : [])
      }
    },
    [
      conceptImages,
      onParamsChange,
      params.generateType,
      params.targetFormat,
      singleViewImage,
      updateConceptImages
    ]
  )

  const handleGenerateTypeChange = React.useCallback(
    (value: string) => {
      const nextGenerateType = value as Hy3dParams['generateType']
      const validFormats =
        isRapidMode && nextGenerateType === 'Geometry'
          ? RAPID_GEOMETRY_TARGET_FORMATS
          : isRapidMode
            ? RAPID_TARGET_FORMATS
            : PRO_TARGET_FORMATS

      onParamsChange({
        generateType: nextGenerateType,
        targetFormat: validFormats.some((item) => item.value === params.targetFormat)
          ? params.targetFormat
          : 'DEFAULT'
      })
    },
    [isRapidMode, onParamsChange, params.targetFormat]
  )

  return (
    <PanelShell title="概念设计" submitLabel="立即生成" submitIcon="sparkle" onSubmit={onGenerate}>
      <ParamSegment
        options={[
          { value: 'pro', label: '专业版' },
          { value: 'rapid', label: '极速版' }
        ]}
        value={isRapidMode ? 'rapid' : 'pro'}
        onChange={setPipelineAction}
      />

      <TopTabs
        options={[
          { value: 'text2_3d', label: '文生3D' },
          { value: 'img2_3d', label: '图生3D' }
        ]}
        value={params.mode}
        onChange={(value) => onParamsChange({ mode: value as Hy3dMode })}
      />

      {params.mode === 'text2_3d' && (
        <Box sx={{ mb: 2, flex: 1, display: 'flex', flexDirection: 'column' }}>
          <TextField
            multiline
            fullWidth
            minRows={7}
            placeholder="例如：一个蒸汽朋克风格的机械猫头鹰，金属羽毛，适合游戏资产"
            value={params.prompt}
            onChange={(event) => {
              if (event.target.value.length <= promptMaxLength) {
                onParamsChange({ prompt: event.target.value })
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
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.8, px: 0.5 }}>
            <Typography sx={{ fontSize: 12, color: hyColors.textSecondary }}>
              {params.prompt.length}/{promptMaxLength}
            </Typography>
          </Box>
        </Box>
      )}

      {params.mode === 'img2_3d' && (
        <Box sx={{ mb: 2, flex: 1, display: 'flex', flexDirection: 'column' }}>
          <Box
            sx={{
              display: 'flex',
              gap: 2.5,
              borderBottom: `1px solid ${hyColors.border}`,
              pb: '8px',
              mb: 2
            }}
          >
            {[
              { id: 'single', label: '单张图片' },
              ...(!isRapidMode ? [{ id: 'multi', label: '多视图' }] : [])
            ].map((tab) => {
              const active = imgSubMode === tab.id
              return (
                <Typography
                  key={tab.id}
                  onClick={() => setImgSubMode(tab.id as 'single' | 'multi')}
                  sx={{
                    fontSize: 13,
                    fontWeight: active ? 600 : 400,
                    color: active ? hyColors.primaryHover : hyColors.textSecondary,
                    cursor: 'pointer',
                    position: 'relative',
                    '&::after': active
                      ? {
                          content: '""',
                          position: 'absolute',
                          left: '10%',
                          right: '10%',
                          bottom: -9,
                          height: 2,
                          bgcolor: hyColors.primaryHover,
                          borderRadius: '2px'
                        }
                      : {}
                  }}
                >
                  {tab.label}
                </Typography>
              )
            })}
          </Box>

          {!isRapidMode && imgSubMode === 'multi' ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, flex: 1 }}>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 1.2,
                  px: 1.6,
                  py: 1.2,
                  bgcolor: hyColors.card,
                  borderRadius: '10px',
                  border: `1px solid ${hyColors.border}`,
                  flexWrap: 'wrap'
                }}
              >
                <Box>
                  <Typography sx={{ fontSize: 13, fontWeight: 600, color: hyColors.textPrimary }}>
                    添加多视图图片
                  </Typography>
                  <Typography sx={{ fontSize: 11.5, color: hyColors.textSecondary, mt: 0.35 }}>
                    正视图必填。专业版 3.1 额外支持顶视、底视和左右前 45°。
                  </Typography>
                </Box>
                <Typography sx={{ fontSize: 12, color: hyColors.textSecondary, flexShrink: 0 }}>
                  已上传 {uploadedCount}/{availableSlots.length}
                </Typography>
              </Box>

              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                  gridTemplateRows: 'repeat(5, auto)',
                  gap: 1.5,
                  alignItems: 'center'
                }}
              >
                {availableSlots.map((slot) => {
                  const image = multiViewImages[slot.apiKey]
                  const isDragOver = multiViewDragOverSlot === slot.apiKey
                  return (
                    <Box
                      key={slot.id}
                      sx={{
                        gridRow: slot.gridRow,
                        gridColumn: slot.gridCol,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 0.7,
                        minWidth: 0
                      }}
                    >
                      <Box
                        onClick={() => !image && handleMultiViewUpload(slot.apiKey)}
                        onDragOver={(event) => handleMultiViewDragOver(slot.apiKey, event)}
                        onDragLeave={handleMultiViewDragLeave}
                        onDrop={(event) => void handleMultiViewDrop(slot.apiKey, event)}
                        {...getPasteTargetProps(slot.apiKey)}
                        sx={{
                          width: '100%',
                          aspectRatio: '1 / 1',
                          borderRadius: '12px',
                          border: `1.5px dashed ${
                            isDragOver
                              ? hyColors.primaryHover
                              : image
                                ? 'transparent'
                                : hyColors.dashedBorder
                          }`,
                          bgcolor: isDragOver
                            ? hyColors.softHoverBg
                            : image
                              ? hyColors.card
                              : hyColors.softBgStrong,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: image ? 'default' : 'pointer',
                          position: 'relative',
                          overflow: 'hidden',
                          outline: 'none',
                          transition: 'all 0.2s ease',
                          '&:hover': image
                            ? {
                                '& .multi-view-overlay': { opacity: 1 }
                              }
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
                              sx={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            />
                            <Box
                              className="multi-view-overlay"
                              sx={{
                                position: 'absolute',
                                inset: 0,
                                bgcolor: 'rgba(0,0,0,0.48)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                opacity: 0,
                                transition: 'opacity 0.2s ease'
                              }}
                            >
                              <IconButton
                                size="small"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  handleMultiViewRemove(slot.apiKey)
                                }}
                                sx={{ color: '#ff4d4f', bgcolor: 'rgba(0,0,0,0.6)' }}
                              >
                                <DeleteOutlineIcon fontSize="small" />
                              </IconButton>
                            </Box>
                          </>
                        ) : (
                          <AddPhotoAlternateOutlinedIcon
                            sx={{ fontSize: 26, color: hyColors.mutedIcon }}
                          />
                        )}
                      </Box>
                      <Typography
                        sx={{
                          fontSize: 10.5,
                          color: image ? hyColors.textPrimary : hyColors.textSecondary,
                          fontWeight: slot.required ? 600 : 400,
                          textAlign: 'center'
                        }}
                      >
                        {slot.label}
                        {slot.required ? '*' : ''}
                      </Typography>
                    </Box>
                  )
                })}
              </Box>
            </Box>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, flex: 1 }}>
              {singleViewImage ? (
                <Box
                  onDragOver={handleSingleViewDragOver}
                  onDragLeave={handleSingleViewDragLeave}
                  onDrop={(event) => void handleSingleViewDrop(event)}
                  {...getPasteTargetProps('single')}
                  sx={{
                    position: 'relative',
                    width: '100%',
                    borderRadius: '10px',
                    overflow: 'hidden',
                    border: `1px solid ${
                      singleViewDragOver ? hyColors.primaryHover : hyColors.softBorder
                    }`,
                    bgcolor: hyColors.card,
                    minHeight: 180,
                    outline: 'none'
                  }}
                >
                  <Box
                    component="img"
                    src={singleViewImage.url}
                    alt="参考图"
                    sx={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                  />
                  <Box sx={{ position: 'absolute', top: 6, right: 6 }}>
                    <IconButton
                      size="small"
                      onClick={handleSingleViewRemove}
                      sx={{
                        bgcolor: 'rgba(0,0,0,0.6)',
                        color: '#ff4d4f',
                        width: 26,
                        height: 26,
                        '&:hover': { bgcolor: 'rgba(0,0,0,0.8)' }
                      }}
                    >
                      <DeleteOutlineIcon sx={{ fontSize: 15 }} />
                    </IconButton>
                  </Box>
                </Box>
              ) : (
                <Box
                  onClick={handleSingleViewUpload}
                  onDragOver={handleSingleViewDragOver}
                  onDragLeave={handleSingleViewDragLeave}
                  onDrop={(event) => void handleSingleViewDrop(event)}
                  {...getPasteTargetProps('single')}
                  sx={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 1,
                    py: 3.5,
                    borderRadius: '10px',
                    border: `1.5px dashed ${
                      singleViewDragOver ? hyColors.primaryHover : hyColors.dashedBorder
                    }`,
                    bgcolor: singleViewDragOver ? hyColors.softHoverBg : hyColors.softBg,
                    cursor: 'pointer',
                    minHeight: 140,
                    outline: 'none',
                    '&:hover': {
                      borderColor: hyColors.softHoverBorder,
                      bgcolor: hyColors.softHoverBg
                    }
                  }}
                >
                  <AddPhotoAlternateOutlinedIcon sx={{ fontSize: 26, color: hyColors.mutedIcon }} />
                  <Typography sx={{ fontSize: 12, color: hyColors.textSecondary, fontWeight: 500 }}>
                    加载参考图
                  </Typography>
                </Box>
              )}
            </Box>
          )}
        </Box>
      )}

      <Box
        onClick={() => setAdvancedOpen((value) => !value)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          py: 0.8,
          mb: 0.5
        }}
      >
        <Typography sx={{ fontSize: 12, fontWeight: 600, color: hyColors.textSecondary }}>
          高级参数
        </Typography>
        {advancedOpen ? (
          <ExpandLessIcon sx={{ fontSize: 16, color: hyColors.textSecondary }} />
        ) : (
          <ExpandMoreIcon sx={{ fontSize: 16, color: hyColors.textSecondary }} />
        )}
      </Box>

      <Collapse in={advancedOpen}>
        <Box
          sx={{
            bgcolor: hyColors.softBg,
            borderRadius: '8px',
            p: 1.5,
            mb: 2,
            border: `1px solid ${hyColors.border}`
          }}
        >
          {!isRapidMode && (
            <>
              <SectionLabel info="专业版支持 3.0 / 3.1，3.1 不支持 LowPoly。" badge="New">
                模型版本
              </SectionLabel>
              <ParamSegment
                options={[
                  { value: '3.1', label: 'V3.1' },
                  { value: '3.0', label: 'V3.0' }
                ]}
                value={params.modelVersion}
                onChange={(value) =>
                  onParamsChange({
                    modelVersion: value as Hy3dParams['modelVersion'],
                    ...(value === '3.1' && params.generateType === 'LowPoly'
                      ? { generateType: 'Normal' as Hy3dParams['generateType'] }
                      : {})
                  })
                }
              />
            </>
          )}

          <SectionLabel>{isRapidMode ? '生成模式' : '生成类型'}</SectionLabel>
          <ParamSegment
            options={generateTypeOptions.map((item) => ({
              value: item.value,
              label: item.label
            }))}
            value={params.generateType}
            onChange={handleGenerateTypeChange}
          />

          {!isRapidMode && params.generateType !== 'LowPoly' && (
            <>
              <SectionLabel info="范围 50000 - 1500000">模型面数</SectionLabel>
              <ParamSegment
                options={FACE_COUNT_PRESETS.map((preset) => ({
                  value: String(preset.value),
                  label: preset.label
                }))}
                value={String(params.faceCount)}
                onChange={(value) => onParamsChange({ faceCount: Number(value) })}
              />
            </>
          )}

          <SectionLabel>
            {isRapidMode ? '输出类型（模型文件/转台视频）' : '输出格式（默认返回 obj+glb 文件组）'}
          </SectionLabel>
          <ParamSegment
            options={targetFormatOptions.map((format) => ({
              value: format.value,
              label: format.label
            }))}
            value={params.targetFormat}
            onChange={(value) =>
              onParamsChange({ targetFormat: value as Hy3dParams['targetFormat'] })
            }
          />

          {params.generateType !== 'Geometry' && (
            <Box
              sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 2 }}
            >
              <SectionLabel info={PBR_MATERIAL_INFO}>PBR 材质</SectionLabel>
              <Switch
                checked={params.enablePBR ?? false}
                onChange={(_, checked) => onParamsChange({ enablePBR: checked })}
                size="small"
                sx={hySwitchSx}
              />
            </Box>
          )}

          {!isRapidMode && params.generateType === 'LowPoly' && params.modelVersion === '3.0' && (
            <>
              <SectionLabel>多边形类型</SectionLabel>
              <ParamSegment
                options={POLYGON_TYPE_OPTIONS.map((item) => ({
                  value: item.value,
                  label: item.label
                }))}
                value={params.polygonType}
                onChange={(value) =>
                  onParamsChange({ polygonType: value as Hy3dParams['polygonType'] })
                }
              />
            </>
          )}
        </Box>
      </Collapse>
    </PanelShell>
  )
}

export default ConceptPanel
