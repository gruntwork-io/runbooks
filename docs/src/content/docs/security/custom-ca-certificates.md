---
title: Custom CA certificates
description: Trust servers whose certificates come from your organization's private certificate authority
---

Some organizations sign their servers' certificates with a private certificate authority (CA), for example for a self-hosted GitLab, an internal registry or a TLS-inspecting proxy. Runbooks can't verify those servers until it trusts that CA: connections to them fail with a certificate error, which the GitHub and GitLab auth blocks show as **Invalid certificate chain**.

Runbooks already trusts the CAs in your operating system's trust store. If your IT team installed the CA there, you don't need to do anything else. On macOS, the certificate must be set to **Always Trust** in Keychain Access. Add a custom CA certificate when you have the CA as a file instead.

## Add a custom CA certificate

1. Open **Custom CA Certificate…** from the **Menu** at the top right of the window, or type "certificate" in the command palette (<kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>K</kbd>). On macOS it is also in the **Runbooks** menu.
2. Click **Choose File…** and pick the CA's certificate file.
3. Check the certificates the dialog lists. Each shows its subject, its issuer, when it expires and its SHA-256 fingerprint. Compare the fingerprint with the one your IT team publishes.

The file can be PEM (`.pem`, `.crt`) with one or more certificates, such as a root CA and its intermediates, or a single DER certificate (`.cer`, the format Windows exports by default).

The setting applies right away, including to the session that is open, and Runbooks keeps it when you restart. Runbooks saves the file's path, not a copy of the file, so leave the file where it is. If you renew the certificate in the same file, choose the file again or restart Runbooks.

Runbooks trusts the file's certificates in addition to the ones it already trusts. It never turns off certificate verification.

To stop trusting the certificate, open the dialog and click **Remove**.

## What uses it

| Connection | Trusts the custom CA |
|------------|----------------------|
| Runbooks' own connections: the GitHub and GitLab APIs, signing in, AWS and Google Cloud | Yes |
| git over HTTPS, in blocks and in scripts | Yes |
| Scripts, and the tools they run that read one of the [variables below](#environment-variables-for-scripts) | Yes |
| Go programs, such as OpenTofu, Terraform, Terragrunt, `gh` and `glab` | On Linux, yes. On macOS and Windows, only builds made with Go 1.27 or later, such as OpenTofu 1.13. [Older builds](#older-go-programs-on-macos-and-windows) use only the OS trust store. |
| macOS's built-in `/usr/bin/python3` | No. It ignores `SSL_CERT_FILE`. A Python installed with Homebrew, mise or pyenv reads it. |
| Web pages embedded in a runbook | No. They use only the OS trust store. |

## Environment variables for scripts

While a custom CA certificate is set, Runbooks writes a bundle file with every certificate it trusts, yours included, to its app data directory. It points these variables at the bundle for every process it starts:

| Variable | Read by |
|----------|---------|
| `NODE_EXTRA_CA_CERTS` | Node.js |
| `SSL_CERT_FILE` | Programs that use OpenSSL's default CA file, such as Python and Ruby, and Go programs: on Linux, and on macOS and Windows from Go 1.27 |
| `GIT_SSL_CAINFO` | git |
| `CURL_CA_BUNDLE` | curl |
| `REQUESTS_CA_BUNDLE` | The Python `requests` library |
| `AWS_CA_BUNDLE` | The AWS CLI and SDKs |
| `CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE` | The Google Cloud CLI (`gcloud`) |

Most of these variables replace a tool's own list of trusted CAs, which is why the bundle holds every certificate Runbooks trusts and not only yours. If your environment already set one of them when Runbooks started, Runbooks adds that file's certificates to the bundle, and restores your value when you remove the custom CA. `GIT_SSL_CAINFO` takes precedence over `http.sslCAInfo` in your git config.

A script that sets one of these variables itself keeps its own value.

When you remove the custom CA, scripts started after that get your environment's values again. Runbooks takes your certificate out of the bundle but keeps the file, because scripts that are already running still point at it.

## Older Go programs on macOS and Windows

Go programs built with Go 1.26 or earlier, such as OpenTofu 1.12 and earlier, ignore `SSL_CERT_FILE` on macOS and Windows. To check which Go a binary was built with, run `go version <path-to-binary>` or look in its release notes.

Some of what these programs do still trusts the custom CA:

- **S3 backend and AWS provider:** both read `AWS_CA_BUNDLE`.
- **Module sources from git** (`git::https://…`): OpenTofu and Terragrunt run git to fetch them, and git reads `GIT_SSL_CAINFO`.

Everything else they fetch over HTTPS themselves, such as providers and modules from a private registry, needs one of these:

- Upgrade to a release built with Go 1.27 or later.
- Install the CA in the OS trust store. On macOS, set it to **Always Trust** in Keychain Access. On Windows, add it to **Trusted Root Certification Authorities**.
