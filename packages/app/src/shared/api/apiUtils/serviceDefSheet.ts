/* eslint-disable @typescript-eslint/no-explicit-any */
// 导入 ServerStreaming 类型
import { ServerStreaming } from './streaming'
import type { ServiceValidator } from './serviceValidation'

// Service 类型约束
export type Service = {
  [key: string]:
    | ((req: any) => Promise<any>) // unary 方法
    | ((req: any, resp: ServerStreaming<any>) => Promise<void>) // serverStreaming 方法
}

export type UnaryServiceDef<REQ, RESP> = {
  type: 'unary'
  /** Optional runtime validation for renderer-provided requests. */
  request?: ServiceValidator<REQ>
  /** Optional runtime validation for main-process responses. */
  response?: ServiceValidator<RESP>
}

export type ServerStreamingServiceDef<REQ, RESP> = {
  type: 'serverStreaming'
  /** Optional runtime validation for renderer-provided stream requests. */
  request?: ServiceValidator<REQ>
  /** Optional runtime validation for each streamed data payload. */
  data?: ServiceValidator<RESP>
}

// ServiceDefSheet 类型
export type ServiceDefSheet<T extends Service> = {
  [K in keyof T]: T[K] extends (req: infer REQ) => Promise<infer RESP>
    ? UnaryServiceDef<REQ, RESP>
    : T[K] extends (req: infer REQ, resp: ServerStreaming<infer RESP>) => Promise<void>
      ? ServerStreamingServiceDef<REQ, RESP>
      : never
}

// ApiType 类型定义
export type ApiType = Record<string, Service>

// ApiDefSheet 类型定义
export type ApiDefSheet<T extends ApiType> = {
  [K in keyof T]: ServiceDefSheet<T[K]>
}
