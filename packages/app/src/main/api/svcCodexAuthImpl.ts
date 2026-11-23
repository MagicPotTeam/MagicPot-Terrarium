import { shell } from 'electron'
import {
  CodexSharedAuthStatus,
  CodexAuthSvc,
  GetCodexStatusReq,
  GetCodexUsageReq,
  GetCodexUsageResp,
  LoginWithCodexReq,
  LoginWithCodexResp,
  LogoutCodexReq,
  LogoutCodexResp
} from '@shared/api/svcCodexAuth'
import { createCodexBetterAuthAdapter, type CodexBetterAuthAdapter } from './codexOAuth'

export class CodexAuthSvcImpl implements CodexAuthSvc {
  constructor(
    private readonly authLifecycle: CodexBetterAuthAdapter = createCodexBetterAuthAdapter({
      openExternal: async (url) => shell.openExternal(url)
    })
  ) {}

  async login(req: LoginWithCodexReq): Promise<LoginWithCodexResp> {
    if (req.mode === 'browser' || req.forceReauth) {
      return await this.authLifecycle.loginWithBrowser({
        forceReauth: req.forceReauth
      })
    }

    return await this.authLifecycle.importSharedLogin()
  }

  async getUsage(_req: GetCodexUsageReq): Promise<GetCodexUsageResp> {
    return await this.authLifecycle.getUsage()
  }

  async status(_req: GetCodexStatusReq): Promise<CodexSharedAuthStatus> {
    return await this.authLifecycle.getStatus()
  }

  async logout(_req: LogoutCodexReq): Promise<LogoutCodexResp> {
    return await this.authLifecycle.logout()
  }
}
