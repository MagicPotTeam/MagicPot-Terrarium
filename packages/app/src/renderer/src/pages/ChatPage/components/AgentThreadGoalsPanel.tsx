import { forwardRef, useImperativeHandle } from 'react'
import type { AgentGoalProgressHandle } from '../goalProgressHandle'
// The canvas already owns the top-level Goals action. Retire this duplicate UI,
// including its dispatch counter/cap selector; never mint or consume a share here.
export default forwardRef<AgentGoalProgressHandle, Record<string, unknown>>(function AgentThreadGoalsPanel(_props, ref) {
  useImperativeHandle(ref, () => ({ take: () => undefined }))
  return null
})
