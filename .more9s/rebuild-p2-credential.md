# Draft: WP 2.13, the credential client, the fake provider, the contract suite (not committed)

Status 2026-11-25: done, handed back. Base: rebuild/p2-plugin-lint 907fda47 (#573). Nothing pushed.

## Branches (stacked in this order)
| PR | Branch | Tip | What |
|---|---|---|---|
| 39 | rebuild/p2-plugin-grace | 1a5e8087 | contract: exitGraceMillis 5 s; base.schema.json callTimeoutsMillis |
| 40 | rebuild/p2-credential-contract | b1f71bf1 | contract: credential.schema.json envValue.file |
| 41 | rebuild/p2-credential-host | f68b0520 | FS modes, providerEnvironment, state folder 0700 |
| 42 | rebuild/p2-plugin-memory | 91a58556 | memoryPluginProcess |
| 43 | rebuild/p2-credential-client | 279804de | openPluginProvider, CREDENTIAL_LIMITS |
| 44 | rebuild/p2-credential-fake | 5d289547 | fake (core) + fake as a process |
| 45 | rebuild/p2-credential-suite | e228503b | credentialProviderContract + AWS offline |
| 46 | rebuild/p2-credential-names | 70ff25fe | parse-time envConflict; names within envNames |

PR bodies: scratchpad/prs/p2-credential-{limits,contract,host,memory,client,fake,suite,names}.md
Checks per commit: scratchpad/credential-work/checks-<hash>/ (each-commit.sh). Mutations: credential-work/mutants/run.py + results.json (18/18 caught).
AWS binary: credential-work/aws-target/debug/runbooks-credential-aws (sha256 8ccf470e...), from git archive of plugins origin/main 6d1ce26, RUSTUP_TOOLCHAIN=1.100.0.
