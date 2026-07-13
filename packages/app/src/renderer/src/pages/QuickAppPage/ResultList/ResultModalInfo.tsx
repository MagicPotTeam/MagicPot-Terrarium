import { Box, Skeleton, Stack, TextField, Typography } from '@mui/material'
import { api } from '@renderer/utils/windowUtils'
import { ComfyHistory } from '@shared/comfy/types'
import { useEffect, useState } from 'react'
import { transformResults } from './resultTransformers'
import { ResultItem } from '@shared/qApp/resultTypes'
import { ResultCardComponent } from './resultCards/types'
import { ResultCardMap } from './resultCards'
import { useConfig } from '@renderer/hooks/useConfig'

type ResultModalInfoProps = {
  promptId: string
}

export default function ResultModalInfo({ promptId }: ResultModalInfoProps) {
  const [isLoading, setIsLoading] = useState(true)
  const [isResultItemsLoading, setIsResultItemsLoading] = useState(true)
  const [historyInfo, setHistoryInfo] = useState<ComfyHistory | null>(null)
  const [resultItems, setResultItems] = useState<ResultItem[]>([])
  const { config, buildEnv } = useConfig()

  useEffect(() => {
    api()
      .svcComfy.getHistory({ prompt_id: promptId })
      .then((res) => {
        setHistoryInfo(res[promptId])
        setIsLoading(false)
        return transformResults(promptId, res[promptId])
      })
      .then(async (items) => {
        if (!items) return
        setResultItems(items)
        setIsResultItemsLoading(false)
      })
  }, [promptId])

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 2, p: 4, width: '100%' }}>
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          overflow: 'auto',
          p: 2,
          height: '100%'
        }}
      >
        <Typography variant="h2">
          {promptId.length > 20 ? `${promptId.slice(0, 20)}...` : promptId}
        </Typography>
        <Typography variant="h4">real prompt_id:</Typography>
        {historyInfo ? (
          <Typography variant="body1">{historyInfo.prompt[1]}</Typography>
        ) : (
          <Skeleton variant="rectangular" height={24} />
        )}
        <Typography variant="h4">status:</Typography>
        {historyInfo ? (
          <Typography variant="body1">{historyInfo.status.status_str}</Typography>
        ) : (
          <Skeleton variant="rectangular" height={24} />
        )}
        <Typography variant="h4">completed:</Typography>
        {historyInfo ? (
          <Typography variant="body1">{historyInfo.status.completed ? 'true' : 'false'}</Typography>
        ) : (
          <Skeleton variant="rectangular" height={24} />
        )}
        <Typography variant="h4">outputs:</Typography>
        {historyInfo ? (
          <TextField multiline value={JSON.stringify(historyInfo.outputs)} fullWidth minRows={1} />
        ) : (
          <Skeleton variant="rectangular" height={100} />
        )}
        <Typography variant="h4">prompt:</Typography>
        {historyInfo ? (
          <TextField
            multiline
            value={JSON.stringify(historyInfo.prompt[2], null, 2)}
            fullWidth
            minRows={10}
            maxRows={10}
          />
        ) : (
          <Skeleton variant="rectangular" height={200} />
        )}
        <Typography variant="h4">history result:</Typography>
        {historyInfo ? (
          <TextField
            multiline
            value={JSON.stringify(historyInfo, null, 2)}
            fullWidth
            minRows={10}
            maxRows={10}
          />
        ) : (
          <Skeleton variant="rectangular" height={100} />
        )}
      </Box>
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          overflow: 'auto',
          p: 2,
          height: '100%',
          width: '100%'
        }}
      >
        {isResultItemsLoading ? (
          <Skeleton variant="rectangular" height={'full'} width={'full'} />
        ) : (
          <Stack spacing={2}>
            {resultItems.map((item, index) => {
              const ResultCard = ResultCardMap[item.type] as ResultCardComponent<typeof item.type>
              return (
                <ResultCard
                  key={item.id}
                  result={item}
                  index={index}
                  config={config}
                  buildEnv={buildEnv}
                  autoSave={false}
                />
              )
            })}
          </Stack>
        )}
      </Box>
    </Box>
  )
}
