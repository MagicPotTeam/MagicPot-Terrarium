import { readFileSync, writeFileSync } from 'fs'

const path = 'packages/app/src/renderer/src/pages/ProjectCanvasPage/useCanvasStageInteraction.ts'
let content = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')

const marker =
  '[beginViewportInteraction, canvasContainerRef, scheduleViewportCommit, scheduleViewportInteractionIdleRelease, scheduleZoomCommit]'
if (!content.includes(marker)) {
  console.error('Marker not found – already patched or file changed')
  process.exit(1)
}

content = content.replace(
  marker,
  '[beginViewportInteraction, canvasContainerRef, scheduleViewportInteractionIdleRelease, scheduleZoomCommit]'
)

const oldGet = '      const canvasRect = canvasContainer.getBoundingClientRect()'
const newGet = `      // Reuse cached rect to avoid getBoundingClientRect() forced layout on every wheel tick.
      // wheelContainerRectRef is invalidated by endViewportInteraction so each new gesture
      // always starts with a fresh measurement.
      let canvasRect = wheelContainerRectRef.current
      if (!canvasRect) {
        const domRect = canvasContainer.getBoundingClientRect()
        canvasRect = {
          left: domRect.left,
          top: domRect.top,
          right: domRect.right,
          bottom: domRect.bottom
        }
        wheelContainerRectRef.current = canvasRect
      }`

if (!content.includes(oldGet)) {
  console.error('getBoundingClientRect line not found in wheel handler')
  process.exit(1)
}

content = content.replace(oldGet, newGet)

writeFileSync(path, content, 'utf8')
console.log('OK – handleStageWheel patched, deps cleaned, rect cached')
