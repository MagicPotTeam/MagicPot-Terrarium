import { useHistory } from '../contexts/HistoryContext'
import { HistoryHandler } from '../types/history'
import { ToolRef } from '../types/tools'

type HistoryResultsProps = {
  toolRefs: Record<string, ToolRef | null>
}

export const HistoryResults = ({ toolRefs }: HistoryResultsProps) => {
  const { historyHandler } = useHistory()
  return (
    <>
      {historyHandler.validLines().map((line, index) => {
        const tool = toolRefs[line.tool]
        if (!tool) {
          console.error(`Tool ${line.tool} not found when rendering line`)
          return null
        }
        return tool.renderLine(line, index)
      })}
    </>
  )
}
