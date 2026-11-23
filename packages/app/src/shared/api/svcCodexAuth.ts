import { ServiceDefSheet } from './apiUtils/serviceDefSheet'

export type LoginWithCodexReq = {
  mode?: 'local' | 'browser'
  forceReauth?: boolean
}

export type LoginWithCodexResp = {
  email?: string
  connectedAt: string
}

export type GetCodexStatusReq = Record<string, never>

export type CodexSharedAuthMode = 'chatgpt' | 'api_key' | 'missing' | 'invalid'

export type CodexSharedAuthReason =
  | 'missing_auth_file'
  | 'invalid_auth_file'
  | 'api_key_mode'
  | 'missing_tokens'
  | 'missing_refresh_token'

export type CodexSharedAuthStatus = {
  available: boolean
  mode: CodexSharedAuthMode
  authFilePath: string
  email?: string
  connectedAt?: string
  reason?: CodexSharedAuthReason
}

export type LogoutCodexReq = {
  scope?: 'shared'
}

export type LogoutCodexResp = {
  cleared: boolean
  authFilePath: string
}

export type CodexUsageWindow = {
  usedPercent: number
  remainingPercent: number
  limitWindowSeconds: number
  resetAfterSeconds: number
  resetAt?: string
}

export type CodexUsageRateLimit = {
  allowed: boolean
  limitReached: boolean
  primaryWindow?: CodexUsageWindow
  secondaryWindow?: CodexUsageWindow
}

export type CodexUsageCredits = {
  hasCredits: boolean
  unlimited: boolean
  balance?: number
  approxLocalMessages?: number
  approxCloudMessages?: number
}

export type GetCodexUsageReq = Record<string, never>

export type GetCodexUsageResp = {
  email?: string
  fetchedAt: string
  planType?: string
  rateLimit?: CodexUsageRateLimit
  credits?: CodexUsageCredits
}

export type CodexAuthSvc = {
  login(req: LoginWithCodexReq): Promise<LoginWithCodexResp>
  getUsage(req: GetCodexUsageReq): Promise<GetCodexUsageResp>
  status(req: GetCodexStatusReq): Promise<CodexSharedAuthStatus>
  logout(req: LogoutCodexReq): Promise<LogoutCodexResp>
}

export const codexAuthSvcDef: ServiceDefSheet<CodexAuthSvc> = {
  login: {
    type: 'unary'
  },
  getUsage: {
    type: 'unary'
  },
  status: {
    type: 'unary'
  },
  logout: {
    type: 'unary'
  }
}
