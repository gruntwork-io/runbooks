/**
 * Computes a SHA256 hash of the given content using the Web Crypto API.
 * Returns the hash as a hex string to match the backend's format.
 */
export async function computeSha256Hash(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

