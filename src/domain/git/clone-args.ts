/**
 * The argv for `git clone`, shared by the Electron IPC clone handler and the
 * `runbooks test` CLI.
 *
 * git reads options anywhere on its command line, so a URL or path passed
 * positionally that begins with `-` would be taken as an option: a clone URL
 * of `--upload-pack=<command>` (or `-u<command>`) makes git run `<command>`
 * through the shell. `--` ends option parsing, so whatever follows is always
 * the repository and the destination. A ref goes in as the value of
 * `--branch`, which consumes the next argument whatever it looks like.
 */
export interface GitCloneArgsOptions {
  /** Branch or tag to check out (`--branch`). */
  readonly ref?: string
  /** Clone blobless and without a checkout, ready for `git sparse-checkout`. */
  readonly sparse?: boolean
}

export function gitCloneArgs(url: string, dest: string, options: GitCloneArgsOptions = {}): string[] {
  const args = ["clone", "--progress"]
  if (options.sparse) args.push("--filter=blob:none", "--no-checkout")
  if (options.ref) args.push("--branch", options.ref)
  args.push("--", url, dest)
  return args
}
