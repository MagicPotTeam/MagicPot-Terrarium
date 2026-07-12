import { ResultCardComponent, ResultCardProps } from './types'
import ResultCardLayout from './components/ResultCardLayout'
import { Box, Stack, Typography, IconButton, Tooltip } from '@mui/material'
import { useState, useEffect } from 'react'
import { ZoomInOutlined, ContentCopy } from '@mui/icons-material'
import ResultIconButtonBase from './components/ResultIconButtonBase'
import ModalLayout from '@renderer/components/ModalLayout'
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import { resolveProjectResourceDir } from '@renderer/utils/projectResourcePaths'
import { createAutoSaveFileName } from './autoSaveTracker'
import { comfyResultAutoSaveClaims } from '@renderer/store/comfyResultResources'

const ResultCardTexts: ResultCardComponent<'texts'> = ({
  result,
  index,
  config,
  buildEnv,
  autoSave = true,
  resultListMethods
}: ResultCardProps<'texts'>) => {
  const [previewOpen, setPreviewOpen] = useState(false)
  const { notifySuccess } = useMessage()

  useEffect(() => {
    if (!autoSave || result.resultItems.length === 0 || !comfyResultAutoSaveClaims.claim(result.id))
      return

    const autoSaveTexts = async () => {
      try {
        const combinedText = result.resultItems
          .map((item) => `[${item.nodeTitle} (${item.nodeId})]\n${item.text}`)
          .join('\n\n---\n\n')

        const fileName = createAutoSaveFileName('.txt')

        const data = new TextEncoder().encode(combinedText)
        const targetDir = resolveProjectResourceDir({
          config: { download_dir: config.download_dir },
          projectId: result.projectId,
          segments: ['.AutoSave', 'QuickApp', 'Texts']
        })

        const res = await api().svcHyper.saveImageToDir({
          data,
          fileName,
          dir: targetDir
        })
        console.log(`[自动保存] 快应用多文本已保存到 ${res.savedPath}`)
      } catch (error) {
        comfyResultAutoSaveClaims.release(result.id)
        console.error('[自动保存] 快应用多文本保存失败:', error)
      }
    }

    autoSaveTexts()
  }, [autoSave, result.id, result.resultItems, result.projectId, config.download_dir])

  let thumbnailResult = result.resultItems
  if (thumbnailResult.length > 5) {
    thumbnailResult = thumbnailResult.slice(0, 5)
  }

  return (
    <ResultCardLayout
      result={result}
      resultListMethods={resultListMethods}
      deleteButtonTooltip="删除文本"
      br={[
        <ResultIconButtonBase
          key="preview"
          tooltip="查看详情"
          onClick={() => setPreviewOpen(true)}
          Icon={ZoomInOutlined}
        />
      ]}
    >
      <Box
        sx={{
          width: '100%',
          p: 2
        }}
      >
        {thumbnailResult.map((item) => (
          <Box key={item.nodeId} sx={{ p: 2 }}>
            <Typography variant="h6" sx={{ mb: 1 }}>
              {item.nodeTitle} ({item.nodeId})
            </Typography>
            <Typography
              sx={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxWidth: '100%'
              }}
            >
              {item.text}
            </Typography>
          </Box>
        ))}
      </Box>
      {previewOpen && (
        <ModalLayout
          open={!!previewOpen}
          setOpen={(open) => setPreviewOpen(open ? previewOpen : false)}
          buttonText=""
          noButton
        >
          <Stack spacing={2} sx={{ p: 3, overflow: 'auto', height: '100%' }}>
            {result.resultItems.map((item) => (
              <Box key={item.nodeId} sx={{ p: 2 }}>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 1
                  }}
                >
                  <Typography variant="h6" sx={{ flex: 1, minWidth: 0 }}>
                    {item.nodeClassType} - {item.nodeTitle}
                  </Typography>
                  <Tooltip title="复制文本">
                    <IconButton
                      size="small"
                      aria-label="复制文本"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(item.text ?? '')
                          notifySuccess('文本已复制')
                        } catch (e) {
                          console.error(e)
                        }
                      }}
                    >
                      <ContentCopy fontSize="inherit" />
                    </IconButton>
                  </Tooltip>
                </Box>
                <Typography
                  variant="body1"
                  sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', mt: 1 }}
                >
                  {item.text}
                </Typography>
              </Box>
            ))}
          </Stack>
        </ModalLayout>
      )}
    </ResultCardLayout>
  )
}

export default ResultCardTexts
