let currentDetection: Promise<{ pid: number }> | null = null

export function detectManagedComfyProcess(
  detect: () => Promise<{ pid: number }>
): Promise<{ pid: number }> {
  if (!currentDetection) {
    currentDetection = detect().finally(() => {
      currentDetection = null
    })
  }
  return currentDetection
}
