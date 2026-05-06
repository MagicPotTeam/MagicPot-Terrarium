import { Box, TextField, Typography } from '@mui/material'
import ModalLayout from '@renderer/components/ModalLayout'
import { useComfyStatus } from '@renderer/store/hooks/comfyStatus'
import { normalizeQAppErrorMessage } from '../utils/qAppErrorMessage'

type ErrorModalProps = {
  promptId: string | null
  setPromptId: (promptId: string | null) => void
}

export default function ErrorModalInfo({ promptId, setPromptId }: ErrorModalProps) {
  const {
    state: { errorPromptStatus }
  } = useComfyStatus()
  const status = promptId ? errorPromptStatus[promptId] : null
  return (
    <ModalLayout noButton buttonText="" open={!!promptId} setOpen={() => setPromptId(null)}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, p: 4, width: '100%' }}>
        {status && (
          <>
            <Typography variant="h2" color="error">
              {status.status_str}
            </Typography>
            <Typography variant="h4">task id:</Typography>
            <Typography variant="body1">{promptId}</Typography>
            <Typography variant="h4">reason:</Typography>
            {status.messages.map((message, index) => {
              if (message[0] === 'prompt_error') {
                return (
                  <Typography variant="body1" key={index}>
                    {normalizeQAppErrorMessage(message[1].error.message)}
                  </Typography>
                )
              }
              if (message[0] === 'execution_error') {
                return (
                  <Typography variant="body1" key={index}>
                    {normalizeQAppErrorMessage(message[1].exception_message)}
                  </Typography>
                )
              }
              return null
            })}
            <Box sx={{ flex: 1, width: '100%', overflow: 'auto', height: '100%' }}>
              <TextField
                multiline
                value={JSON.stringify(status, null, 2)}
                fullWidth
                minRows={10}
                sx={{ flex: 1 }}
              />
            </Box>
          </>
        )}
        {!status && <Typography variant="body1">没有错误信息</Typography>}
      </Box>
    </ModalLayout>
  )
}
