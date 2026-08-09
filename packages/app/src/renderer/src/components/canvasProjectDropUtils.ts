export function isCanvasSceneFile(file: File): boolean {
  return /\.mpcanvas$/i.test(file.name)
}

export function getCanvasProjectName(fileName: string): string {
  const name = fileName.replace(/\.mpcanvas$/i, '').trim()
  return name || 'Imported Canvas'
}
