/**
 * A request an auth block sends as the signed-in user, for another block such
 * as a lookup, and the answer it got. The auth block adds the credentials, so
 * neither shape ever carries one.
 */
export interface HttpRequest {
  readonly method: "GET" | "POST"
  readonly url: string
  /** Header names are lowercase. */
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string | undefined
}

/** The server's answer, whatever its status. */
export interface HttpReply {
  readonly status: number
  readonly contentType: string
  readonly body: string
}
