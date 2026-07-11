import { useEffect } from 'react'

import {
  attachCanvasSpatialIndexAccelerator,
  disposeCanvasSpatialIndex,
  type CanvasSpatialIndex
} from './canvasSpatialIndex'
import {
  scheduleCanvasSpatialIndexAcceleratorIdleWarmup,
  shouldScheduleCanvasSpatialIndexAcceleratorWarmup
} from './canvasSpatialIndexAccelerator'

export function useCanvasSpatialIndexLifecycle<T>(
  index: CanvasSpatialIndex<T> | null | undefined,
  { warmup = false }: { warmup?: boolean } = {}
): void {
  useEffect(() => {
    if (
      !warmup ||
      !index ||
      !shouldScheduleCanvasSpatialIndexAcceleratorWarmup(index.entries.length)
    ) {
      return undefined
    }
    return scheduleCanvasSpatialIndexAcceleratorIdleWarmup()
  }, [index, warmup])

  useEffect(() => {
    attachCanvasSpatialIndexAccelerator(index)
    return () => disposeCanvasSpatialIndex(index)
  }, [index])
}
