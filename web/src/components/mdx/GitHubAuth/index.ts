import { GitHubAuth } from './GitHubAuth'

export { GitHubAuth }
export default GitHubAuth

// GitHubAuth is now a thin alias of <GitAuth>; the types live in the GitAuth
// module. Re-export GitHubAuthProps here so existing importers of
// `@/components/mdx/GitHubAuth` keep working unchanged.
export type { GitHubAuthProps } from '@/components/mdx/GitAuth/types'

export { isCliAuthFound } from '@/components/mdx/GitAuth/types'
