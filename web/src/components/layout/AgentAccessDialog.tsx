import { useEffect, useState } from "react"
import { Copy } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useApi } from "@/contexts/ApiContext"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import { CopyIconButton } from "./CopyIconButton"
import type { AgentServerStatus } from "../../../../src/domain/agent/protocol"

interface AgentAccessDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The AI agent access setting (AI Agent Access…): an MCP server on this
 * machine's loopback address that lets an agent such as Claude Code drive the
 * runbook open in this window. Off by default. Main runs the server; this
 * turns it on and off, and shows how to connect an agent.
 */
export function AgentAccessDialog({ open, onOpenChange }: AgentAccessDialogProps) {
  const api = useApi()
  const [status, setStatus] = useState<AgentServerStatus | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    api
      .invoke("agent:status")
      .then(setStatus)
      .catch((err: unknown) => setProblem(cleanIpcErrorMessage(String(err))))
    return api.on("agent:status-changed", setStatus)
  }, [api, open])

  const update = (change: { enabled?: boolean; confirmRuns?: boolean }) => {
    setBusy(true)
    setProblem(null)
    api
      .invoke("agent:update", change)
      .then(setStatus)
      .catch((err: unknown) => setProblem(cleanIpcErrorMessage(String(err))))
      .finally(() => setBusy(false))
  }

  // Single-quoted for the shell, with any ' in the path closed, escaped and reopened
  const helper = status?.headersFile
    ? `cat '${status.headersFile.replaceAll("'", "'\\''")}'`
    : undefined
  const mcpJson =
    status?.url && helper
      ? JSON.stringify(
          { mcpServers: { runbooks: { type: "http", url: status.url, headersHelper: helper } } },
          null,
          2,
        )
      : undefined

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>AI Agent Access</DialogTitle>
          <DialogDescription>
            Let an AI agent such as Claude Code read and run the runbook open in this window over
            the Model Context Protocol. Everything it does shows here, and you can stop a run or
            take over at any time. The agent runs blocks with your credentials, so turn this on only
            for agents you trust.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm" data-testid="agent-access">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              data-testid="agent-access-enabled"
              className="mt-1"
              checked={status?.enabled ?? false}
              disabled={busy || status === null}
              onChange={(e) => update({ enabled: e.target.checked })}
            />
            <span>
              <strong>Allow AI agents to connect</strong>
              <br />
              <span className="text-muted-foreground">
                Serves MCP on 127.0.0.1 only, with a token that changes every time Runbooks starts.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              data-testid="agent-access-confirm"
              className="mt-1"
              checked={status?.confirmRuns ?? true}
              disabled={busy || status === null}
              onChange={(e) => update({ confirmRuns: e.target.checked })}
            />
            <span>
              <strong>Ask me before an agent runs a block</strong>
            </span>
          </label>

          {status?.error && <p className="text-destructive">{status.error}</p>}
          {problem && <p className="text-destructive">{problem}</p>}

          {status?.url && status.claudeCommand && (
            <div className="space-y-3">
              <div>
                <p className="font-medium">Connect Claude Code for this launch</p>
                <div className="flex items-start gap-2">
                  <code className="block flex-1 break-all rounded bg-muted p-2 text-xs">
                    {status.claudeCommand}
                  </code>
                  <CopyIconButton
                    value={status.claudeCommand}
                    icon={Copy}
                    label="Copy command"
                    copiedLabel="Copied"
                  />
                </div>
              </div>
              {mcpJson && (
                <div>
                  <p className="font-medium">Or keep it connected across launches</p>
                  <p className="text-muted-foreground">
                    Add this to <code>.mcp.json</code> or <code>~/.claude.json</code>. Claude Code
                    runs the <code>headersHelper</code> command to read the current token.
                  </p>
                  <div className="flex items-start gap-2">
                    <pre className="flex-1 overflow-x-auto rounded bg-muted p-2 text-xs">
                      {mcpJson}
                    </pre>
                    <CopyIconButton
                      value={mcpJson}
                      icon={Copy}
                      label="Copy configuration"
                      copiedLabel="Copied"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
