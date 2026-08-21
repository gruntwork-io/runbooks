import type { GitCloneProps, GitCloneSource } from './types'

/**
 * Which source the block starts on. An author who prefills a checkout
 * directory means "use that local repo", so it wins over the clone default;
 * an explicit `source` prop always wins over both.
 */
export function resolveInitialSource(
  props: Pick<GitCloneProps, 'source' | 'prefilledRepoDir'>,
): GitCloneSource {
  return props.source ?? (props.prefilledRepoDir ? 'local' : 'clone')
}

/** Default block description, which differs per source when the author sets none. */
export function defaultDescription(source: GitCloneSource): string {
  return source === 'local'
    ? 'Select a repository you already have checked out on this machine'
    : 'Enter a git URL to clone a repository'
}
