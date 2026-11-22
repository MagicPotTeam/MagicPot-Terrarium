import path from 'node:path'
import type { BrowserWindow } from 'electron'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import type {
  BeginReportBundleReq,
  BeginReportBundleResp,
  PurgeReportBundlesReq,
  PurgeReportBundlesResp,
  RegisterReportBundleReq,
  RegisterReportBundleResp,
  ReportBundlesSvc,
  VerifyReportBundlesReq,
  VerifyReportBundlesResp
} from '@shared/api/svcReportBundles'
import { authorizeMagicAgentApprovalRenderer } from '../magicAgentRuntime/trustedRouteBinding'
import { getConfig } from '../config/config'
import { getBuildEnv } from '../config/buildEnv'
import {
  beginReportBundle,
  purgeReportBundleRecords,
  registerReportBundle,
  verifyReportBundles
} from '../reportBundles/reportBundleRegistry'

const ACCESS_DENIED = 'Report bundle access denied.'

/** MAIN's own report-bundle roots: the producer's project root and the build data path. */
export function resolveReportBundleRoots(): string[] {
  const roots: string[] = []
  try {
    const downloadDir = getConfig().download_dir?.trim()
    if (downloadDir && path.isAbsolute(downloadDir)) roots.push(downloadDir)
  } catch {
    // Config not initialised yet: only the data path is a root.
  }
  try {
    const dataDir = getBuildEnv().pathMap.data?.trim()
    if (dataDir && path.isAbsolute(dataDir)) roots.push(dataDir)
  } catch {
    // No data path: no root.
  }
  return roots
}

export type ReportBundlesSvcDeps = {
  getMainWindow: () => BrowserWindow | null
  getBundleRoots?: () => string[]
}

export class ReportBundlesSvcImpl implements ReportBundlesSvc {
  private readonly getMainWindow: () => BrowserWindow | null
  private readonly getBundleRoots: () => string[]

  constructor(deps: ReportBundlesSvcDeps) {
    this.getMainWindow = deps.getMainWindow
    this.getBundleRoots = deps.getBundleRoots ?? resolveReportBundleRoots
  }

  beginBundle = async (
    req: BeginReportBundleReq,
    invocation?: ServiceInvocationContext
  ): Promise<BeginReportBundleResp> => {
    this.authorize('beginBundle', invocation)
    return await beginReportBundle(req, this.getBundleRoots())
  }

  register = async (
    req: RegisterReportBundleReq,
    invocation?: ServiceInvocationContext
  ): Promise<RegisterReportBundleResp> => {
    this.authorize('register', invocation)
    return await registerReportBundle(req)
  }

  verify = async (
    req: VerifyReportBundlesReq,
    invocation?: ServiceInvocationContext
  ): Promise<VerifyReportBundlesResp> => {
    this.authorize('verify', invocation)
    return await verifyReportBundles(req)
  }

  /** Records only: the user deleted these conversations or this project. */
  purge = async (
    req: PurgeReportBundlesReq,
    invocation?: ServiceInvocationContext
  ): Promise<PurgeReportBundlesResp> => {
    this.authorize('purge', invocation)
    return await purgeReportBundleRecords(
      'storageScopePrefix' in req
        ? { storageScopePrefix: req.storageScopePrefix }
        : { conversationIds: req.conversationIds, storageScope: req.storageScope }
    )
  }

  /**
   * Only the app's main window main frame may use this service, through IPC. A missing
   * invocation context is refused (unlike direct main-process callers elsewhere): MAIN code
   * uses the registry module directly.
   */
  private authorize(method: keyof ReportBundlesSvc, invocation?: ServiceInvocationContext): void {
    try {
      if (
        !invocation ||
        invocation.methodName !== `svcReportBundles.${method}` ||
        !Number.isSafeInteger(invocation.senderId) ||
        invocation.isMainFrame !== true
      ) {
        throw new Error(ACCESS_DENIED)
      }
      authorizeMagicAgentApprovalRenderer(invocation)
      const parent = this.getMainWindow()
      if (
        !parent ||
        parent.isDestroyed() ||
        parent.webContents.isDestroyed() ||
        parent.webContents.id !== invocation.senderId
      ) {
        throw new Error(ACCESS_DENIED)
      }
      // Invocation URLs are snapshots; recheck the live document as well.
      const url = parent.webContents.getURL()
      authorizeMagicAgentApprovalRenderer({ ...invocation, frameUrl: url, senderUrl: url })
    } catch {
      throw new Error(ACCESS_DENIED)
    }
  }
}
