/**
 * 这个文件的存在是为了规避 Browser 端由于隔离没有一些常用方法的问题
 * 1. path join 或 basename 等方法
 * 2. shell 打开文件夹等
 * 通过在 preload 往 window 注入，使渲染进程处理与 Node 端一致
 */

///////////
// built-in path
///////////

export type FormatInputPathObject = {
  /**
   * The root of the path such as '/' or 'c:\'
   */
  root?: string | undefined
  /**
   * The full directory path such as '/home/user/dir' or 'c:\path\dir'
   */
  dir?: string | undefined
  /**
   * The file name including extension (if any) such as 'index.html'
   */
  base?: string | undefined
  /**
   * The file extension (if any) such as '.html'
   */
  ext?: string | undefined
  /**
   * The file name without extension (if any) such as 'index'
   */
  name?: string | undefined
}

export type BuiltInPath = {
  normalize(path: string): string
  isAbsolute(path: string): boolean
  join(first: string, ...args: string[]): string
  relative(from: string, to: string): string
  dirname(path: string): string
  basename(path: string, ext?: string): string
  extname(path: string): string
  format(pathObject: FormatInputPathObject): string
  parse(path: string): FormatInputPathObject
}

/**
 * 窗口控制 API ，暴露给标题栏使用
 */
export type WinBridge = {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  isMaximized: () => Promise<boolean>
  close: () => Promise<void>
  onMaximizeChanged: (cb: (isMax: boolean) => void) => () => void
}
