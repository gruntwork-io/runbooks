import { ExternalLink } from "lucide-react"

interface DeviceCodePromptProps {
  deviceCode: { verificationUri: string; userCode: string }
}

export function DeviceCodePrompt({ deviceCode }: DeviceCodePromptProps) {
  return (
    <div
      className="bg-info-muted border border-info/40 rounded p-3 text-sm"
      data-testid="azure-device-code"
    >
      <div className="mb-2">
        Open{" "}
        <a
          href={deviceCode.verificationUri}
          target="_blank"
          rel="noreferrer"
          className="text-info underline inline-flex items-center gap-1"
        >
          {deviceCode.verificationUri}
          <ExternalLink className="size-3" />
        </a>{" "}
        and enter this code:
      </div>
      <div className="font-mono text-lg font-bold tracking-widest select-all">
        {deviceCode.userCode}
      </div>
    </div>
  )
}
