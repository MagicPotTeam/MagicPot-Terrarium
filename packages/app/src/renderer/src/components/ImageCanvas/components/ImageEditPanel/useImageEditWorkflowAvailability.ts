import { useEffect, useState } from 'react'
import { api } from '@renderer/utils/windowUtils'
import {
  canLaunchImageEditWorkflow,
  type ImageEditWorkflowTarget
} from './imageEditWorkflowTargets'

type WorkflowAvailabilityStatus = 'checking' | 'ready' | 'missing'

export const useImageEditWorkflowAvailability = (workflow: ImageEditWorkflowTarget) => {
  const [status, setStatus] = useState<WorkflowAvailabilityStatus>(() =>
    canLaunchImageEditWorkflow(workflow) ? 'checking' : 'missing'
  )

  useEffect(() => {
    let cancelled = false
    const workflowKey = workflow.key.trim()

    if (!workflowKey) {
      setStatus('missing')
      return () => {
        cancelled = true
      }
    }

    setStatus('checking')

    void api()
      .svcQApp.getQAppCfg({ key: workflowKey })
      .then(() => {
        if (!cancelled) {
          setStatus('ready')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('missing')
        }
      })

    return () => {
      cancelled = true
    }
  }, [workflow])

  return {
    status,
    isChecking: status === 'checking',
    isLaunchable: status === 'ready'
  }
}
