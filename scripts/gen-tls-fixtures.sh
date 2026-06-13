#!/usr/bin/env bash
# Generates the committed TLS test fixtures under test/fixtures/tls/:
# a self-signed fixture CA plus a localhost leaf certificate signed by it.
# The fixtures stand in for "a custom root CA in the OS trust store" in the
# integration suite (test/integration/), since CI cannot mutate a real
# keychain. 100-year expiry so the fixtures never rot in CI.
#
# Run once and commit the output; re-run only if the fixtures ever need to
# be regenerated (e.g. key-size policy changes).
set -euo pipefail

cd "$(dirname "$0")/.."
out="test/fixtures/tls"
mkdir -p "$out"

days=36500 # ~100 years

# 1. Fixture CA (self-signed root).
openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
  -keyout "$out/ca-key.pem" -out "$out/ca.pem" \
  -days "$days" \
  -subj "/CN=Runbooks TLS Test Fixture CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

# 2. Leaf key + CSR for localhost.
openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout "$out/localhost-key.pem" -out "$out/localhost.csr" \
  -subj "/CN=localhost"

# 3. Sign the leaf with the fixture CA, with localhost SANs.
openssl x509 -req -sha256 \
  -in "$out/localhost.csr" \
  -CA "$out/ca.pem" -CAkey "$out/ca-key.pem" -CAcreateserial \
  -out "$out/localhost-cert.pem" \
  -days "$days" \
  -extfile <(printf '%s\n' \
    "basicConstraints=critical,CA:FALSE" \
    "keyUsage=critical,digitalSignature,keyEncipherment" \
    "extendedKeyUsage=serverAuth" \
    "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1")

rm -f "$out/localhost.csr" "$out/ca.srl"

echo "TLS fixtures written to $out/"
