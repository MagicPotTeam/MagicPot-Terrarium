import { useState } from 'react'
import type { ChatAttachment } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import {
  createChatAttachmentRenderKeyState,
  reconcileChatAttachmentRenderKeyState
} from './chatAttachmentRenderKeyState'

export function useChatAttachmentRenderKeys(
  attachments: readonly ChatAttachment[]
): readonly string[] {
  const [state, setState] = useState(() => createChatAttachmentRenderKeyState(attachments))
  const next = reconcileChatAttachmentRenderKeyState(state, attachments)
  if (next !== state) {
    // React retries this component before rendering its children; abandoned renders mutate no cache.
    setState(next)
  }
  return next.keys
}
