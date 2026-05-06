import { Outputs, Workflow } from '@shared/comfy/types'
import { ResultItemType, ResultItemTypeMap } from '@shared/qApp/resultTypes'

export type ResultTransformer<ItemType extends ResultItemType> = (
  promptId: string,
  outputs: Record<string, Outputs>,
  workflow: Workflow
) => Promise<ResultItemTypeMap[ItemType][]>
