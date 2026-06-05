/**
 * Environment for spawning `git` so it can never block on an interactive
 * prompt. Shared by the GitClient layer, the Electron IPC clone handler, and
 * the remote-source resolver — every place that shells out to git.
 *
 * Without these, a clone/push/ls-remote can hang forever:
 *
 *  - SSH host-key verification. The first time we connect to a host that isn't
 *    in known_hosts, ssh asks "Are you sure you want to continue connecting?"
 *    and reads the answer from the controlling terminal — which a spawned git
 *    process has no way to answer, so it blocks indefinitely.
 *  - SSH passphrase / password prompts.
 *  - git's own HTTPS credential prompt.
 *
 * GIT_SSH_COMMAND forces ssh into batch mode (BatchMode=yes → never prompt;
 * fail instead) and keeps strict host-key checking on: an unknown host fails
 * fast with "Host key verification failed" rather than hanging or silently
 * trusting it. To clone such a host, add its key to known_hosts first
 * (e.g. `ssh-keyscan <host> >> ~/.ssh/known_hosts`). ssh still reads
 * ~/.ssh/config, so per-host IdentityFile settings are honored.
 *
 * GIT_TERMINAL_PROMPT=0 makes git itself fail instead of prompting for
 * credentials on the terminal (the HTTPS equivalent of the SSH hang).
 *
 * process.env is spread first so PATH, HOME, and SSH_AUTH_SOCK (the ssh-agent
 * socket) are preserved — passing an explicit env to spawn() replaces the
 * inherited one wholesale, so omitting these would break git and ssh entirely.
 */
export const gitSpawnEnv = (): Record<string, string | undefined> => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes",
})
