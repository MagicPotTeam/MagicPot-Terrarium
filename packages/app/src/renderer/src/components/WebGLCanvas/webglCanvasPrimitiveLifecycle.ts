/** Remove and destroy display objects created by a primitive layer. */
export function destroyWebGLCanvasPrimitiveChildren(container: {
  removeChildren: () => Array<{ destroy: () => void }>
}) {
  for (const child of container.removeChildren()) {
    child.destroy()
  }
}
