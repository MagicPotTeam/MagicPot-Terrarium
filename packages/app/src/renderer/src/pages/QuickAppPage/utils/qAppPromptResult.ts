import type { GetHistoryResp, WaitPromptIdResp } from '@shared/api/svcComfy'
import type { ComfyHistory } from '@shared/comfy/types'

type QAppPromptResultClient = {
  getHistory: (req: { prompt_id: string }) => Promise<GetHistoryResp>
  waitPromptId: (
    req: { prompt_id: string },
    resp: { onData: (data: WaitPromptIdResp) => void }
  ) => Promise<void>
}

export const waitForQAppPromptResult = async (
  client: QAppPromptResultClient,
  promptId: string
): Promise<ComfyHistory> => {
  const existingHistory = await client.getHistory({ prompt_id: promptId })
  if (existingHistory[promptId]) {
    return existingHistory[promptId]
  }

  return new Promise<ComfyHistory>((resolve, reject) => {
    client
      .waitPromptId(
        { prompt_id: promptId },
        {
          onData: (data) => {
            if (data[promptId]) {
              resolve(data[promptId])
              return
            }

            reject(new Error(`Missing prompt history for ${promptId}`))
          }
        }
      )
      .catch(reject)
  })
}
