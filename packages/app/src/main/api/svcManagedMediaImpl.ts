import fs from 'node:fs/promises'
import type {
  EnsureManagedMediaDerivativeReq,
  EnsureManagedMediaDerivativeResp,
  ManagedMediaDerivativeDescriptor,
  ManagedMediaSvc
} from '@shared/api/svcManagedMedia'
import { validateEnsureManagedMediaDerivativeResp } from '@shared/api/svcManagedMedia'
import { ServiceError } from '@shared/api/apiUtils/serviceValidation'
import { getChatMediaDir } from '../llmProxy/chatMediaDir'
import {
  ensureManagedMediaDerivative,
  type EnsureManagedMediaDerivativeResult
} from '../llmProxy/managedMediaDerivatives'
import { ManagedMediaResolutionError } from '../llmProxy/managedMediaStore'

export type ManagedMediaSvcImplDependencies = {
  ensureDerivative?: typeof ensureManagedMediaDerivative
  getMediaDir?: typeof getChatMediaDir
  realpath?: typeof fs.realpath
}

const invalidDependencyResult = (): ServiceError =>
  new ServiceError('Unable to prepare managed media derivative', {
    code: 'MANAGED_MEDIA_DERIVATIVE_FAILED'
  })

function readyDescriptor(
  result: EnsureManagedMediaDerivativeResult,
  requestedMaxEdge: EnsureManagedMediaDerivativeReq['maxEdge']
): ManagedMediaDerivativeDescriptor | undefined {
  if (
    result.purpose !== 'managed-media-derivative' ||
    result.maxEdge !== requestedMaxEdge ||
    result.mimeType !== 'image/webp' ||
    !result.relativePath.endsWith('.webp') ||
    Math.max(result.width, result.height) > requestedMaxEdge
  ) {
    return undefined
  }

  const response = {
    status: 'ready' as const,
    descriptor: {
      maxEdge: result.maxEdge,
      relativePath: result.relativePath,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      width: result.width,
      height: result.height,
      sha256: result.sha256,
      localMediaUrl: result.localMediaUrl
    }
  }
  try {
    return validateEnsureManagedMediaDerivativeResp(response).status === 'ready'
      ? response.descriptor
      : undefined
  } catch {
    return undefined
  }
}

export class ManagedMediaSvcImpl implements ManagedMediaSvc {
  constructor(private readonly dependencies: ManagedMediaSvcImplDependencies = {}) {}

  async ensureDerivative(
    req: EnsureManagedMediaDerivativeReq
  ): Promise<EnsureManagedMediaDerivativeResp> {
    const getMediaDir = this.dependencies.getMediaDir ?? getChatMediaDir
    const realpath = this.dependencies.realpath ?? fs.realpath
    const derive = this.dependencies.ensureDerivative ?? ensureManagedMediaDerivative

    try {
      // getMediaDir is the sole authority for both dependency injection and production roots.
      const authorizedRoot = await realpath(getMediaDir())
      const result: EnsureManagedMediaDerivativeResult = await derive({
        authorizedRoot,
        reference: req.reference,
        maxEdge: req.maxEdge
      })

      if (result.purpose === 'original-fallback') {
        if (
          result.status !== 'unsupported' ||
          result.reason !== 'animated-gif' ||
          result.maxEdge !== req.maxEdge ||
          !result.original ||
          result.original.metadata?.mimeType !== 'image/gif'
        ) {
          throw invalidDependencyResult()
        }
        const response = {
          status: 'fallbackOriginal' as const,
          reason: 'animated-gif' as const,
          localMediaUrl: result.original.localMediaUrl
        }
        return validateEnsureManagedMediaDerivativeResp(response)
      }

      const descriptor = readyDescriptor(result, req.maxEdge)
      if (!descriptor) throw invalidDependencyResult()
      return { status: 'ready', descriptor }
    } catch (error) {
      if (error instanceof ManagedMediaResolutionError) {
        throw new ServiceError(
          error.code === 'MANAGED_MEDIA_MISSING'
            ? 'Managed media is missing'
            : 'Managed media is corrupt',
          { code: error.code }
        )
      }
      if (error instanceof ServiceError) throw error
      throw invalidDependencyResult()
    }
  }
}
