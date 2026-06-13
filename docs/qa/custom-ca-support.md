# Support guide: custom certificate authorities (self-hosted GitLab/GitHub)

Runbooks makes its VCS API calls in-process and trusts the union of Node's
bundled Mozilla roots **plus the OS trust store** (plus any per-host
`ca_cert` PEM referenced in glab's config). Verification is never disabled:
`skip_tls_verify`, `GIT_SSL_NO_VERIFY`, and similar are deliberately ignored.

When a customer reports "Invalid credentials" or a TLS card against a
self-hosted instance behind a custom CA, walk this ladder top-down — it is
the same ladder the in-app TLS card suggests.

## 1. Install the CA in the OS trust store (the default fix)

- **macOS**: Keychain Access → **System** keychain → import the root CA →
  set **Always Trust** for SSL. Hostname-scoped or per-app trust is **not
  enough** — Node's system reader skips it (this is the likely cause when
  `gh`/`glab`/`git` already work on the machine but Runbooks shows the TLS
  card). After installing **mid-session**, click **Retry** on the card — no
  app restart needed.
- **Windows**: import into **Trusted Root Certification Authorities**
  (machine store; Group Policy distribution works).
- **Linux**: the distro bundle (`update-ca-certificates` /
  `update-ca-trust`).

## 2. glab per-host ca_cert (GitLab, no admin rights needed)

```
glab config set ca_cert /path/to/ca.pem --host <instance-host>
```

Then click **Reload** next to the host picker. Runbooks harvests per-host
`ca_cert` PEMs from glab's config and adds them (additively) to its trust.

## 3. Advanced: NODE_EXTRA_CA_CERTS

Launch Runbooks with the env var set (it must exist at launch — Finder/dock
launches won't inherit a shell export):

```
NODE_EXTRA_CA_CERTS=/path/to/ca.pem open -a Runbooks   # macOS example
```

## Windows git clones: the schannel switch

Git for Windows defaults to the OpenSSL HTTPS backend with its own CA
bundle, which **ignores the Windows certificate store**. API calls and the
OAuth flow are unaffected, but `git clone`/`push` against the instance need:

```
git config --global http.sslBackend schannel
```

Runbooks surfaces this proactively on the auth success card for non-public
GitLab hosts, with a consented one-click apply (it never writes git config
silently).

## Diagnostics worth collecting

- The launch log line `installSystemTrust: defaults=… system=… extra=…` —
  `system=0` on a machine with OS-installed CAs indicates a Node
  system-reader gap.
- A `transport degraded for <host>: …` log line means the §2.4 CLI probe
  validated the credential while Runbooks' direct connection is still
  TLS-blocked — almost always hostname-scoped/per-app trust (see ladder
  step 1) on macOS.
- `gh api user` / `glab api user --hostname <H>` as a side-by-side check:
  the CLIs use the OS store via Go's TLS stack.
