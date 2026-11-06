// `crypto.randomUUIDv7` has been in Node since 24.16, and @types/node 25 does
// not declare it yet. Delete this file once it does.
declare module "node:crypto" {
  /** A version 7 UUID (RFC 9562): its first 48 bits are the current time in Unix milliseconds, so UUIDs sort by creation time. */
  function randomUUIDv7(options?: RandomUUIDOptions): UUID
}
