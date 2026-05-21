import { Box, Typography } from '@mui/material'
import ResultCardLayout from './components/ResultCardLayout'
import { ResultCardComponent, ResultCardProps } from './types'
import { useMessage } from '@renderer/hooks/useMessage'
import { useEffect } from 'react'
import { api } from '@renderer/utils/windowUtils'
import { resolveProjectResourceDir } from '@renderer/utils/projectResourcePaths'

// 记录已经自动保存过的文本，防止组件重新挂载时重复保存
const autoSavedTextTracker = new Set<string>()

const ResultCardText: ResultCardComponent<'text'> = ({
  result,
  index,
  config,
  buildEnv,
  resultListMethods
}: ResultCardProps<'text'>) => {
  const { notifySuccess } = useMessage()

  useEffect(() => {
    if (!result.text || autoSavedTextTracker.has(result.text)) return
    autoSavedTextTracker.add(result.text)

    const autoSaveText = async () => {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const fileName = `qapp_auto_${timestamp}.txt`

        const data = new TextEncoder().encode(result.text)
        const targetDir = resolveProjectResourceDir({
          config: { download_dir: config.download_dir },
          projectId: result.projectId,
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
        console.error('[自动保存] 快应用文本保存失败:', error)
      }
    }

    autoSaveText()
  }, [result.text, result.projectId, config.download_dir])

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
