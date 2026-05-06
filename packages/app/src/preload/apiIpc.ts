import { Api, apiDef } from '@shared/api'
import { createIpcClient } from '@shared/api/createClient/createIpcClient'

export function newApiIpc(): Api {
  return createIpcClient<Api>(apiDef)
}
