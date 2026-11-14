/**
 * The title each Agent pane showed last, by pane scope. Memory only: nothing is persisted.
 *
 * AgentWorkspace is mounted again whenever the project tab changes and reads the conversations
 * of its panes asynchronously. With this a thread keeps its previous text until its real title
 * is known again, instead of showing a numbered label first.
 */
const titlesByScope = new Map<string, string>()

export const rememberPaneTitle = (scope: string, title: string | undefined): void => {
  if (title !== undefined) titlesByScope.set(scope, title)
}

export const recallPaneTitle = (scope: string): string | undefined => titlesByScope.get(scope)

export const forgetPaneTitles = (): void => titlesByScope.clear()
