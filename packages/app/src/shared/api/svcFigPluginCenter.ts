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
