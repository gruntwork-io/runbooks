import { createContext, type ReactNode } from "react"

/**
 * A notice the chapter on screen shows at its top, where moving to a chapter
 * brings its start into view: the Runbook changed notice. MDXContainer
 * provides it to a runbook with chapters, which shows it there instead of
 * with the session notice at the top of the runbook. Outside a provider, none.
 */
export const ChapterNoticeContext = createContext<ReactNode>(null)
