import type { ServiceDefSheet } from './apiUtils/serviceDefSheet'
import { ServiceValidationError } from './apiUtils/serviceValidation'
import { canonicalFigPluginJson } from '../figplugin/manifest'
import {
  figPluginCenterOperationSchema,
  figPluginCenterResponseSchema,
  type FigPluginCenterOperation,
  type FigPluginCenterResponse
} from '../figplugin/center'

import {
  figPluginManagedListSchema,
  figPluginManagementEmptyRequestSchema,
  figPluginPackagePreviewSchema,
  figPluginPackageInstallRequestSchema,
  figPluginManagedConfigureRequestSchema,
  figPluginManagedRemoveRequestSchema,
  figPluginManagedTargetSchema,
  figPluginManagedMutationSchema,
  figPluginManagedPathResultSchema,
  parseFigPluginManagementValue,
  type FigPluginManagedList,
  type FigPluginPackagePreview,
  type FigPluginPackageInstallRequest,
  type FigPluginManagedConfigureRequest,
  type FigPluginManagedRemoveRequest,
  type FigPluginManagedTarget,
  type FigPluginManagedMutation
} from '../figplugin/management'
import { z } from 'zod'
import {
  figPluginExecutionHistoryRequestSchema,
  figPluginExecutionHistorySchema,
  type FigPluginExecutionHistoryRequest,
  type FigPluginExecutionHistory
} from '../figplugin/executionAudit'
import {
  figPluginDesktopPairRequestSchema,
  figPluginDesktopPairTicketSchema,
  figPluginDesktopApprovalSchema,
  figPluginDesktopCallSchema,
  figPluginBridgeDesktopStateSchema,
  parseFigPluginBridgeValue,
  type FigPluginDesktopPairRequest,
  type FigPluginDesktopPairTicket,
  type FigPluginDesktopApproval,
  type FigPluginBridgeDesktopState
} from '../figplugin/bridge'
import {
  figPluginDesktopExecutionApprovalSchema,
  figPluginDesktopExecutionSchema,
  figPluginDesktopVisualBaselineAcceptanceSchema,
  figPluginDesktopVisualCorrectionAuthorizationRequestSchema,
  figPluginDesktopVisualCorrectionAuthorizationSchema,
  figPluginExecutionDesktopStateSchema,
  figPluginVisualBaselineSchema,
  figPluginVisualCorrectionAuthorizationSchema,
  type FigPluginDesktopExecution,
  type FigPluginDesktopExecutionApproval,
  type FigPluginDesktopVisualBaselineAcceptance,
  type FigPluginDesktopVisualCorrectionAuthorization,
  type FigPluginDesktopVisualCorrectionAuthorizationRequest,
  type FigPluginExecutionDesktopState,
  type FigPluginVisualBaseline,
  type FigPluginVisualCorrectionAuthorization
} from '../figplugin/execution'

/** One control plane: legacy metadata and verified materialization remain non-executing. */
export type FigPluginCenterSvc = {
  execute(operation: FigPluginCenterOperation): Promise<FigPluginCenterResponse>
  listPackages(req: Record<string, never>): Promise<FigPluginManagedList>
  choosePackage(req: Record<string, never>): Promise<FigPluginPackagePreview | null>
  installPackage(req: FigPluginPackageInstallRequest): Promise<FigPluginManagedMutation>
  configurePackage(req: FigPluginManagedConfigureRequest): Promise<FigPluginManagedMutation>
  removePackage(req: FigPluginManagedRemoveRequest): Promise<FigPluginManagedMutation>
  copyPackagePath(req: FigPluginManagedTarget): Promise<{ completed: boolean }>
  revealPackage(req: FigPluginManagedTarget): Promise<{ completed: boolean }>
  discardPreview(req: { receiptId: string }): Promise<void>
  createPairing(req: FigPluginDesktopPairRequest): Promise<FigPluginDesktopPairTicket | null>
  bridgeState(req: Record<string, never>): Promise<FigPluginBridgeDesktopState>
  approveBridge(req: FigPluginDesktopApproval): Promise<{ completed: boolean }>
  denyBridge(req: { callId: string }): Promise<void>
  revokeBridge(req: { pluginId: string }): Promise<void>
  planState(req: Record<string, never>): Promise<FigPluginExecutionDesktopState>
  executionHistory(req: FigPluginExecutionHistoryRequest): Promise<FigPluginExecutionHistory>
  approvePlanExecution(req: FigPluginDesktopExecutionApproval): Promise<{ completed: boolean }>
  acceptVisualBaseline(
    req: FigPluginDesktopVisualBaselineAcceptance
  ): Promise<FigPluginVisualBaseline | null>
  authorizeVisualCorrection(
    req: FigPluginDesktopVisualCorrectionAuthorizationRequest
  ): Promise<FigPluginVisualCorrectionAuthorization | null>
  cancelVisualCorrectionAuthorization(
    req: FigPluginDesktopVisualCorrectionAuthorization
  ): Promise<void>
  denyPlanExecution(req: FigPluginDesktopExecution): Promise<void>
  cancelPlanExecution(req: FigPluginDesktopExecution): Promise<void>
}

const validated =
  <Schema extends z.ZodTypeAny>(schema: Schema) =>
  (value: unknown): z.output<Schema> =>
    parseFigPluginManagementValue(schema, value)

export const figPluginCenterSvcDef: ServiceDefSheet<FigPluginCenterSvc> = {
  createPairing: {
    type: 'unary',
    request: (value) => parseFigPluginBridgeValue(figPluginDesktopPairRequestSchema, value),
    response: figPluginDesktopPairTicketSchema.nullable()
  },
  bridgeState: {
    type: 'unary',
    request: validated(figPluginManagementEmptyRequestSchema),
    response: figPluginBridgeDesktopStateSchema
  },
  approveBridge: {
    type: 'unary',
    request: (value) => parseFigPluginBridgeValue(figPluginDesktopApprovalSchema, value),
    response: figPluginManagedPathResultSchema
  },
  denyBridge: {
    type: 'unary',
    request: (value) => parseFigPluginBridgeValue(figPluginDesktopCallSchema, value),
    response: z.void()
  },
  revokeBridge: {
    type: 'unary',
    request: validated(figPluginManagedTargetSchema.pick({ pluginId: true })),
    response: z.void()
  },
  executionHistory: {
    type: 'unary',
    request: validated(figPluginExecutionHistoryRequestSchema),
    response: figPluginExecutionHistorySchema
  },
  planState: {
    type: 'unary',
    request: validated(figPluginManagementEmptyRequestSchema),
    response: figPluginExecutionDesktopStateSchema
  },
  approvePlanExecution: {
    type: 'unary',
    request: (value) => parseFigPluginBridgeValue(figPluginDesktopExecutionApprovalSchema, value),
    response: figPluginManagedPathResultSchema
  },
  acceptVisualBaseline: {
    type: 'unary',
    request: (value) =>
      parseFigPluginBridgeValue(figPluginDesktopVisualBaselineAcceptanceSchema, value),
    response: figPluginVisualBaselineSchema.nullable()
  },
  authorizeVisualCorrection: {
    type: 'unary',
    request: (value) =>
      parseFigPluginBridgeValue(figPluginDesktopVisualCorrectionAuthorizationRequestSchema, value),
    response: figPluginVisualCorrectionAuthorizationSchema.nullable()
  },
  cancelVisualCorrectionAuthorization: {
    type: 'unary',
    request: (value) =>
      parseFigPluginBridgeValue(figPluginDesktopVisualCorrectionAuthorizationSchema, value),
    response: z.void()
  },
  denyPlanExecution: {
    type: 'unary',
    request: (value) => parseFigPluginBridgeValue(figPluginDesktopExecutionSchema, value),
    response: z.void()
  },
  cancelPlanExecution: {
    type: 'unary',
    request: (value) => parseFigPluginBridgeValue(figPluginDesktopExecutionSchema, value),
    response: z.void()
  },
  listPackages: {
    type: 'unary',
    request: validated(figPluginManagementEmptyRequestSchema),
    response: figPluginManagedListSchema
  },
  choosePackage: {
    type: 'unary',
    request: validated(figPluginManagementEmptyRequestSchema),
    response: figPluginPackagePreviewSchema.nullable()
  },
  installPackage: {
    type: 'unary',
    request: validated(figPluginPackageInstallRequestSchema),
    response: figPluginManagedMutationSchema
  },
  configurePackage: {
    type: 'unary',
    request: validated(figPluginManagedConfigureRequestSchema),
    response: figPluginManagedMutationSchema
  },
  removePackage: {
    type: 'unary',
    request: validated(figPluginManagedRemoveRequestSchema),
    response: figPluginManagedMutationSchema
  },
  copyPackagePath: {
    type: 'unary',
    request: validated(figPluginManagedTargetSchema),
    response: figPluginManagedPathResultSchema
  },
  revealPackage: {
    type: 'unary',
    request: validated(figPluginManagedTargetSchema),
    response: figPluginManagedPathResultSchema
  },
  discardPreview: {
    type: 'unary',
    request: validated(z.object({ receiptId: z.string().regex(/^[a-f0-9]{48}$/) }).strict()),
    response: z.void()
  },
  execute: {
    type: 'unary',
    request: (value: unknown): FigPluginCenterOperation => {
      try {
        const operation = figPluginCenterOperationSchema.parse(value)
        if (operation.kind === 'configure') {
          // Isolate nested config from caller mutation while the store waits for its lock.
          operation.config = JSON.parse(canonicalFigPluginJson(operation.config))
        }
        return operation
      } catch {
        // IPC logs validation errors. Zod issues/causes can contain caller data or secret keys.
        throw new ServiceValidationError('FIGPLUGIN center request')
      }
    },
    response: figPluginCenterResponseSchema
  }
}
