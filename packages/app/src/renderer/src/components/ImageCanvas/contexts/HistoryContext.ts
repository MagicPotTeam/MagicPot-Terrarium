import { createContext, createElement, useContext, useState } from 'react'
import { History, HistoryHandler, PenShape } from '../types/history'

type HistoryContextType = {
  history: History
  historyHandler: HistoryHandler
}

const HistoryContext = createContext<HistoryContextType>({
  history: { top: 0, lines: [] },
  historyHandler: {
    pushHistory: () => {},
    updateHistory: () => {},
    undoHistory: () => {},
    redoHistory: () => {},
    clearHistory: () => {},
    topLine: () => ({ points: [], tool: '', width: 0, shape: 'round' }),
    validLines: () => []
  }
})

export const HistoryProvider = ({ children }: { children: React.ReactNode }) => {
  const [history, setHistory] = useState<History>({ top: 0, lines: [] })
  const pushHistory = (
    tool: string,
    width: number,
    shape: PenShape,
    pos: { x: number; y: number }
  ) => {
    setHistory((history) => {
      return {
        top: history.top + 1,
        lines: [
          ...history.lines.slice(0, history.top),
          { tool, width, shape, points: [pos.x, pos.y] }
        ]
      }
    })
  }
  const updateHistory = (point: { x: number; y: number }) => {
    setHistory((history) => {
      const line = history.lines[history.top - 1]
      line.points = line.points.concat([point.x, point.y])
      history.lines.splice(history.top - 1, 1, line)
      return { ...history }
    })
  }
  const undoHistory = () => {
    setHistory((history) => ({
      top: history.top - 1,
      lines: history.lines
    }))
  }
  const redoHistory = () => {
    setHistory((history) => {
      if (history.top >= history.lines.length) {
        return history
      }
      return {
        top: history.top + 1,
        lines: history.lines
      }
    })
  }
  const clearHistory = () => {
    setHistory({ top: 0, lines: [] })
  }
  const topLine = () => {
    return history.lines[history.top - 1]
  }
  const validLines = () => {
    return history.lines.slice(0, history.top)
  }

  const historyHandler = {
    pushHistory,
    updateHistory,
    undoHistory,
    redoHistory,
    clearHistory,
    topLine,
    validLines
  }
  return createElement(HistoryContext.Provider, { value: { history, historyHandler } }, children)
}

export const useHistory = () => {
  return useContext(HistoryContext)
}
