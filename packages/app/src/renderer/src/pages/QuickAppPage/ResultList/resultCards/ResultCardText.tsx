import { Box, Typography } from '@mui/material'
import ResultCardLayout from './components/ResultCardLayout'
import { ResultCardComponent, ResultCardProps } from './types'
import { useMessage } from '@renderer/hooks/useMessage'
import { useEffect } from 'react'
import { api } from '@renderer/utils/windowUtils'
import { resolveProjectResourceDir } from '@renderer/utils/projectResourcePaths'
import { createAutoSaveFileName } from './autoSaveTracker'
import { comfyResultAutoSaveClaims } from '@renderer/store/comfyResultResources'

const ResultCardText: ResultCardComponent<'text'> = ({
  result,
  index,
  config,
  buildEnv,
  autoSave = true,
  resultListMethods
}: ResultCardProps<'text'>) => {
  const { notifySuccess } = useMessage()

  useEffect(() => {
    if (!autoSave || !result.text || !comfyResultAutoSaveClaims.claim(result.id)) return

    const autoSaveText = async () => {
      try {
        const fileName = createAutoSaveFileName('.txt')

        const data = new TextEncoder().encode(result.text)
        const targetDir = resolveProjectResourceDir({
          config: { download_dir: config.download_dir },
          segments: ['.AutoSave', 'QuickApp', 'Texts']
        })

        const res = await api().svcHyper.saveImageToDir({
          // re-using this for raw buffer saving
          data,
          fileName,
          dir: targetDir
        })
        console.log(`[自动保存] 快应用文本已保存到 ${res.savedPath}`)
      } catch (error) {
        comfyResultAutoSaveClaims.release(result.id)
        console.error('[自动保存] 快应用文本保存失败:', error)
      }
    }

    autoSaveText()
  }, [autoSave, result.id, result.text, result.projectId, config.download_dir])

  return (
    <ResultCardLayout
      result={result}
      resultListMethods={resultListMethods}
      deleteButtonTooltip="删除文本"
    >
      <Box
        sx={{
          width: '100%',
          overflow: 'visible',
          p: 2,
          cursor: 'pointer'
        }}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(result.text)
            notifySuccess('文本已复制')
          } catch (e) {
            console.error(e)
          }
        }}
      >
        <Typography variant="h6" sx={{ mb: 1 }}>
          {result.nodeTitle} ({result.nodeId})
        </Typography>
        <Typography
          sx={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            maxWidth: '100%'
          }}
        >
          {result.text}
        </Typography>
      </Box>
    </ResultCardLayout>
  )
}

export default ResultCardText
