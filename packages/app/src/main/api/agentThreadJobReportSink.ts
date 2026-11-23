import { canvasThreadStorageScopeOfRoute } from '@shared/agent'
import type { AgentThreadInbox } from './agentThreadInbox'
import { jobReportIdempotencyKey, type AgentThreadJobReportSink } from './agentThreadJobReports'

/**
 * MAIN-only bridge from the job registries to the thread inbox (S3). A canvas thread session gets
 * one job_done event per job (the idempotency key is the job id); a route with no canvas thread
 * storage scope has no inbox session and reports nothing.
 */
export function createJobReportSink(
  inbox: Pick<AgentThreadInbox, 'enqueue' | 'withdraw'>
): AgentThreadJobReportSink {
  return {
    report(report) {
      const storageScope = canvasThreadStorageScopeOfRoute(report.route)
      if (!storageScope) return
      inbox.enqueue({
        route: report.route,
        storageScope,
        conversationId: report.conversationId,
        type: 'job_done',
        source: report.source,
        text: report.text,
        idempotencyKey: jobReportIdempotencyKey(report.jobId)
      })
    },
    withdraw(scope, jobId) {
      const storageScope = canvasThreadStorageScopeOfRoute(scope.route)
      if (!storageScope) return
      inbox.withdraw(
        { route: scope.route, storageScope, conversationId: scope.conversationId },
        jobReportIdempotencyKey(jobId)
      )
    }
  }
}
