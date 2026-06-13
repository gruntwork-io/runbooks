# Manual QA release gate: custom root CA, end to end

These are the scenarios CI cannot truthfully automate (vcs-auth-v2-design.md
§9): CI cannot mutate a real OS trust store, so the literal
system-store-read legs are verified by hand before any release that touches
TLS, credential detection, or the git transport. The automated coverage
around them: the in-Electron launch canary (`installSystemTrust: … system>0`),
the `test/integration/` suite (fixture-CA recovery + the §3.1 system-reader
contract pins), and the `electron/e2e/vcs-auth.spec.ts` flights (ca_cert
harvest, TLS card + Retry via the test seam, §2.4 probe degradation).

Run both rows against a self-hosted GitLab instance whose certificate chains
to a CUSTOM root CA (not publicly trusted).

## macOS row

Setup: install the custom root CA in the **System keychain** via Keychain
Access and set **Always Trust** for SSL. (Hostname-scoped or per-app trust is
deliberately out of scope — Node's system reader skips it; that machine class
degrades to §2.4 probe-validated auth, which is the *next* row's check.)

1. **Detect**: open a runbook with a `<GitAuth provider="gitlab">` block and
   the instance configured in glab (`glab auth login --hostname <H>`).
   Expected: zero-click success card naming the instance; **no** TLS card;
   **never** "Invalid credentials detected".
2. **Validate (PAT)**: re-authenticate via "Other instance…" + a pasted PAT.
   Expected: success; `vcs-auth.json` gains the host (hostnames only).
3. **Clone → push → MR**: run a clone block against a private repo on the
   instance, push a change, open an MR.
   Expected: all three succeed with no TLS prompts (macOS git uses
   SecureTransport — already OS-trusted).
4. **Mid-session install**: remove the CA from the keychain, relaunch, confirm
   the TLS card appears; re-install the CA (Always Trust) **without
   relaunching**, click **Retry** on the card.
   Expected: recovery without app restart (the §3.1 cold out-of-process read);
   the main log shows `installSystemTrust: … (refresh, coldReadOk=true)`.
5. **Degraded sliver** (optional, hostname-scoped trust): scope the CA's trust
   to the instance hostname only. Expected: success card carrying
   "validated via glab CLI …" plus the remediation warning; MR/label API
   calls surface the TLS card; git operations unaffected; the log shows
   `transport degraded for <host>: …`.

## Windows row

Setup: corp/custom CA in the **machine** store (Trusted Root Certification
Authorities) + a **default Git-for-Windows install** (OpenSSL backend — do
NOT preconfigure schannel).

1. **API + OAuth legs**: GitAuth detection and the GitHub OAuth device flow.
   Expected: work with **no user action** (Node's system reader consults the
   Windows stores).
2. **Proactive schannel suggestion**: after a successful GitLab auth against
   the non-public instance, the success card shows "Git for Windows is using
   the OpenSSL backend…" with the one-click **Apply**.
   Expected: the suggestion appears **before** any clone is attempted; the
   apply runs `git config --global http.sslBackend schannel` only on the
   explicit button press — never silently.
3. **Clone/push after consent**: click Apply, then clone and push against the
   instance. Expected: both succeed; `git config --global http.sslBackend`
   reads `schannel`.
4. **Reactive fallback**: on a fresh profile (OpenSSL backend restored),
   attempt the clone first. Expected: the clone failure surfaces the same
   schannel suggestion copy — suggest or one-click with consent, never silent.
