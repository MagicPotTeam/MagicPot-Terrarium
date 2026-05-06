import { HistoryHandler } from './history'
import { TransformHandler } from './transform'

export type ActionCtx = {
  transformHandler: TransformHandler
  historyHandler: HistoryHandler
}
