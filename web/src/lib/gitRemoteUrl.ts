/**
 * Git remote URL parsing for the renderer.
 *
 * The implementation lives in src/domain/git/remote-url.ts so the main
 * process, the `runbooks test` CLI and this UI split a remote into host,
 * port, user and path exactly the same way (IPv6 literals, ports, subgroups
 * and userinfo included).
 */
export {
  parseGitRemoteUrl,
  gitRemoteOwnerRepo,
  gitRemoteWebHost,
  type GitRemoteUrl,
  type GitRemoteOwnerRepo,
} from "../../../src/domain/git/remote-url"
