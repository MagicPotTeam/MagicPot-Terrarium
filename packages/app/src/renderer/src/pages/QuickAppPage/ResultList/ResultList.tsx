import { Box, Stack, Typography, IconButton, Tooltip, useTheme } from '@mui/material'
import { Image as ImageIcon, ChevronLeft, ChevronRight } from '@mui/icons-material'
import { useComfyStatus } from '@renderer/store/hooks/comfyStatus'
import { useConfig } from '@renderer/hooks/useConfig'
import { useState, useEffect, useMemo, useCallback } from 'react'
import ModalLayout from '@renderer/components/ModalLayout'
import ResultModalInfo from './ResultModalInfo'
import { ResultCardMap } from './resultCards'
import { ResultCardComponent } from './resultCards/types'
import { useTranslation } from 'react-i18next'
import ImageViewer from '@renderer/components/ImageCanvas/ImageViewer'

type ResultListProps = {}

const RESULT_LAYOUT_KEY = 'resultListLayout'

// 单列图标：一个方块
const SingleColumnIcon = () => (
  <Box
    sx={{
      width: 20,
      height: 20,
      backgroundColor: 'currentColor',
      borderRadius: 0
    }}
  />
)

// 双列图标：四个方块组成的大方块
const DoubleColumnIcon = () => (
  <Box
    sx={{
      width: 20,
      height: 20,
      display: 'grid',
      gridTemplateColumns: 'repeat(2, 1fr)',
      gridTemplateRows: 'repeat(2, 1fr)',
      gap: 0.5
    }}
  >
    <Box sx={{ backgroundColor: 'currentColor', borderRadius: 0 }} />
    <Box sx={{ backgroundColor: 'currentColor', borderRadius: 0 }} />
    <Box sx={{ backgroundColor: 'currentColor', borderRadius: 0 }} />
    <Box sx={{ backgroundColor: 'currentColor', borderRadius: 0 }} />
  </Box>
)

export default function ResultList({}: ResultListProps) {
  const { t } = useTranslation()
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'
  const { config, buildEnv } = useConfig()
  const {
    state: { results },
    deleteResult
  } = useComfyStatus()

  const [infoPromptId, setInfoPromptId] = useState<string | null>(null)
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null)

  // 收集所有图片结果的 {url, id} 列表
  const allImageResults = useMemo(
    () =>
      results
        .filter((r) => r.type === 'image')
        .map((r) => ({ url: (r as { objectUrl: string }).objectUrl, id: r.id })),
    [results]
  )

  const allImageUrls = useMemo(() => allImageResults.map((r) => r.url), [allImageResults])

  const currentPreviewIndex = useMemo(
    () => (previewImageUrl ? allImageUrls.indexOf(previewImageUrl) : -1),
    [previewImageUrl, allImageUrls]
  )

  const navigatePreview = useCallback(
    (direction: 'prev' | 'next') => {
      if (currentPreviewIndex < 0 || allImageUrls.length <= 1) return
      const newIndex =
        direction === 'prev'
          ? (currentPreviewIndex - 1 + allImageUrls.length) % allImageUrls.length
          : (currentPreviewIndex + 1) % allImageUrls.length
      setPreviewImageUrl(allImageUrls[newIndex])
    },
    [currentPreviewIndex, allImageUrls]
  )

  // 删除当前预览的图片
  const deleteCurrentPreview = useCallback(() => {
    if (currentPreviewIndex < 0) return
    const currentResult = allImageResults[currentPreviewIndex]
    if (!currentResult) return

    // 预先计算下一张要显示的图片
    if (allImageResults.length <= 1) {
      // 最后一张，关闭预览
      setPreviewImageUrl(null)
    } else {
      // 切到下一张（或最后一张时切到上一张）
      const nextIndex =
        currentPreviewIndex < allImageResults.length - 1
          ? currentPreviewIndex + 1
          : currentPreviewIndex - 1
      setPreviewImageUrl(allImageResults[nextIndex].url)
    }

    // 执行删除
    deleteResult(currentResult.id)
  }, [currentPreviewIndex, allImageResults, deleteResult])

  // 键盘事件：左右键切换图片，Delete 删除，Esc 关闭
  useEffect(() => {
    if (!previewImageUrl) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        navigatePreview('prev')
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        navigatePreview('next')
      } else if (e.key === 'Delete') {
        e.preventDefault()
        deleteCurrentPreview()
      } else if (e.key === 'Escape') {
        setPreviewImageUrl(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [previewImageUrl, navigatePreview, deleteCurrentPreview])
  const [isTwoColumn, setIsTwoColumn] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(RESULT_LAYOUT_KEY)
      return saved === 'two-column'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(RESULT_LAYOUT_KEY, isTwoColumn ? 'two-column' : 'one-column')
    } catch {
      // 忽略 localStorage 错误
    }
  }, [isTwoColumn])

  return (
    <Box>
      {results.length > 0 ? (
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', mb: 2 }}>
            <Typography
              variant="caption"
              sx={{ color: 'text.disabled', mr: 1, fontSize: '0.7rem', userSelect: 'none' }}
            >
              可拖拽图片到左侧加载参数
            </Typography>
            <Tooltip title={isTwoColumn ? '切换为单列' : '切换为双列'}>
              <IconButton
                onClick={() => setIsTwoColumn(!isTwoColumn)}
                size="small"
                sx={{
                  color: isLight ? '#808080' : 'text.secondary'
                }}
              >
                {isTwoColumn ? <DoubleColumnIcon /> : <SingleColumnIcon />}
              </IconButton>
            </Tooltip>
          </Box>

          {/* 结果列表 */}
          {isTwoColumn ? (
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: 2,
                width: '100%'
              }}
            >
              {results.map((result, index) => {
                const ResultCard = ResultCardMap[result.type] as ResultCardComponent<
                  typeof result.type
                >
                return (
                  <Box key={index} sx={{ width: '100%', minWidth: 0 }}>
                    <ResultCard
                      result={result}
                      index={index}
                      config={config}
                      buildEnv={buildEnv}
                      resultListMethods={{
                        deleteResult,
                        setInfoPromptId,
                        openImagePreview: setPreviewImageUrl
                      }}
                    />
                  </Box>
                )
              })}
            </Box>
          ) : (
            <Stack spacing={2}>
              {results.map((result, index) => {
                const ResultCard = ResultCardMap[result.type] as ResultCardComponent<
                  typeof result.type
                >
                return (
                  <ResultCard
                    key={index}
                    result={result}
                    index={index}
                    config={config}
                    buildEnv={buildEnv}
                    resultListMethods={{
                      deleteResult,
                      setInfoPromptId,
                      openImagePreview: setPreviewImageUrl
                    }}
                  />
                )
              })}
            </Stack>
          )}
        </Box>
      ) : (
        <Box sx={{ textAlign: 'center', py: 4, color: 'text.secondary' }}>
          <ImageIcon sx={{ fontSize: 48, mb: 2, opacity: 0.5 }} />
          <Typography>{t('quickapp.results.empty')}</Typography>
        </Box>
      )}
      {infoPromptId && (
        <ModalLayout
          open={!!infoPromptId}
          setOpen={(open) => setInfoPromptId(null)}
          buttonText=""
          noButton
        >
          <ResultModalInfo promptId={infoPromptId} />
        </ModalLayout>
      )}
      {/* 全局图片预览 Modal（支持左右键切换） */}
      {previewImageUrl && (
        <ModalLayout
          open={!!previewImageUrl}
          setOpen={(open) => !open && setPreviewImageUrl(null)}
          buttonText=""
          noButton
        >
          <Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
            <ImageViewer imageUrl={previewImageUrl} onDelete={deleteCurrentPreview} />
            {allImageUrls.length > 1 && (
              <>
                {/* 左箭头 */}
                <IconButton
                  onClick={() => navigatePreview('prev')}
                  sx={{
                    position: 'absolute',
                    left: 8,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    bgcolor: 'rgba(0,0,0,0.5)',
                    color: '#fff',
                    '&:hover': { bgcolor: 'rgba(0,0,0,0.7)' },
                    zIndex: 10
                  }}
                >
                  <ChevronLeft fontSize="large" />
                </IconButton>
                {/* 右箭头 */}
                <IconButton
                  onClick={() => navigatePreview('next')}
                  sx={{
                    position: 'absolute',
                    right: 8,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    bgcolor: 'rgba(0,0,0,0.5)',
                    color: '#fff',
                    '&:hover': { bgcolor: 'rgba(0,0,0,0.7)' },
                    zIndex: 10
                  }}
                >
                  <ChevronRight fontSize="large" />
                </IconButton>
                {/* 计数器 */}
                <Box
                  sx={{
                    position: 'absolute',
                    bottom: 12,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    bgcolor: 'rgba(0,0,0,0.5)',
                    color: '#fff',
                    px: 2,
                    py: 0.5,
                    borderRadius: '12px',
                    fontSize: '0.875rem',
                    zIndex: 10
                  }}
                >
                  {currentPreviewIndex + 1} / {allImageUrls.length}
                </Box>
              </>
            )}
          </Box>
        </ModalLayout>
      )}
    </Box>
  )
}
