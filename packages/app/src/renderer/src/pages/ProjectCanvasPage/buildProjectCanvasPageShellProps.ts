export type ProjectCanvasPageShellPropsGroup = Record<string, unknown>

const SHELL_ACTION_PROP_PATTERN = /^(handle|open|close|pause|resume|start|stop|update)/

function pickShellProps(
  source: ProjectCanvasPageShellPropsGroup,
  predicate: (key: string) => boolean
): ProjectCanvasPageShellPropsGroup {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => predicate(key))
  ) as ProjectCanvasPageShellPropsGroup
}

export function buildProjectCanvasPageShellProps(
  props: ProjectCanvasPageShellPropsGroup
): ProjectCanvasPageShellPropsGroup {
  const shellCommonProps = pickShellProps(
    props,
    (key) => !key.startsWith('set') && !SHELL_ACTION_PROP_PATTERN.test(key)
  )
  const shellActionProps = pickShellProps(props, (key) => SHELL_ACTION_PROP_PATTERN.test(key))
  const shellSetterProps = pickShellProps(props, (key) => key.startsWith('set'))

  return Object.assign({}, shellCommonProps, shellActionProps, shellSetterProps)
}
