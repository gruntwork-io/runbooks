/**
 * The app's MCP endpoint: Streamable HTTP at http://127.0.0.1:<port>/mcp,
 * served only while the user has turned agent access on.
 *
 * Every request must:
 *  - arrive on the loopback address (the server listens on 127.0.0.1 only);
 *  - name that address in its Host header, so a web page can't reach it
 *    through DNS rebinding;
 *  - carry no Origin header, so a web page in a browser can't call it at all
 *    (MCP clients such as Claude Code don't send one);
 *  - carry `Authorization: Bearer <token>`, the random token of this launch.
 *
 * No electron import, so Bun can test it.
 */
import * as http from "node:http"
import { timingSafeEqual } from "node:crypto"
import type { AddressInfo } from "node:net"
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server"

export const MCP_PATH = "/mcp"

export interface AgentServerOptions {
  port: number
  token: string
  /** A fresh MCP server for one request. */
  createServer: () => McpServer
  /** Called for each request that passes the checks, e.g. to show the window that an agent is active. */
  onAuthorizedRequest?: () => void
}

export interface RunningAgentServer {
  url: string
  port: number
  close: () => Promise<void>
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "")
  if (!match) return false
  const given = Buffer.from(match[1]!.trim())
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** Why the request is refused, as [status, message], or null to serve it. */
export function rejectReason(
  req: Pick<http.IncomingMessage, "headers" | "url">,
  port: number,
  token: string,
): [number, string] | null {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  if (url.pathname !== MCP_PATH) return [404, "Not found"]
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return [403, "Host not allowed"]
  }
  if (req.headers.origin !== undefined) return [403, "Browser requests are not allowed"]
  if (!tokenMatches(req.headers.authorization, token)) return [401, "Missing or wrong bearer token"]
  return null
}

/** Far more than any tool call needs. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large")
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** Start listening on 127.0.0.1. Rejects if the port is taken. */
export function startAgentServer(opts: AgentServerOptions): Promise<RunningAgentServer> {
  const handler = createMcpHandler(() => opts.createServer())

  const server = http.createServer((req, res) => {
    const refused = rejectReason(req, actualPort(), opts.token)
    if (refused) {
      const [status, message] = refused
      const headers: Record<string, string> = { "content-type": "text/plain" }
      if (status === 401) headers["www-authenticate"] = "Bearer"
      res.writeHead(status, headers).end(message)
      return
    }
    opts.onAuthorizedRequest?.()
    void (async () => {
      try {
        const body = await readBody(req)
        const headers = new Headers()
        for (const [name, value] of Object.entries(req.headers)) {
          if (Array.isArray(value)) value.forEach((v) => headers.append(name, v))
          else if (value !== undefined) headers.set(name, value)
        }
        const request = new Request(`http://${req.headers.host}${req.url}`, {
          method: req.method ?? "GET",
          headers,
          ...(body.length > 0 ? { body } : {}),
        })
        const response = await handler.fetch(request)
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
        if (response.body) {
          for await (const chunk of response.body) res.write(chunk)
        }
        res.end()
      } catch (err: unknown) {
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" })
        res.end(err instanceof Error ? err.message : "Internal error")
      }
    })()
  })

  const actualPort = () => (server.address() as AddressInfo | null)?.port ?? opts.port

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", reject)
      const port = actualPort()
      resolve({
        port,
        url: `http://127.0.0.1:${port}${MCP_PATH}`,
        close: () =>
          new Promise<void>((done) => {
            void handler.close()
            server.closeAllConnections()
            server.close(() => done())
          }),
      })
    })
  })
}
