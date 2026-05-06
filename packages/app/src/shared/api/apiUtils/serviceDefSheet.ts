/* eslint-disable @typescript-eslint/no-explicit-any */
// 导入 ServerStreaming 类型
import { ServerStreaming } from './streaming'

// Service 类型约束
export type Service = {
  [key: string]:
    | ((req: any) => Promise<any>) // unary 方法
    | ((req: any, resp: ServerStreaming<any>) => Promise<void>) // serverStreaming 方法
}

// ServiceDefSheet 类型
export type ServiceDefSheet<T extends Service> = {
  [K in keyof T]: T[K] extends (req: any) => Promise<any>
    ? { type: 'unary' }
    : T[K] extends (req: any, resp: ServerStreaming<any>) => Promise<void>
      ? { type: 'serverStreaming' }
      : never
}

// ApiType 类型定义
export type ApiType = Record<string, Service>

// ApiDefSheet 类型定义
export type ApiDefSheet<T extends ApiType> = {
  [K in keyof T]: ServiceDefSheet<T[K]>
}
