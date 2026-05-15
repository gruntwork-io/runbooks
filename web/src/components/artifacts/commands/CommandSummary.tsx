import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronDown, ChevronRight, XCircle, Check } from "lucide-react"
import { useState } from 'react'
import { LinkifiedText } from "@/components/shared/LinkifiedText"
import type { LogEntry } from "@/hooks/useApiExec"

export interface CommandSummaryProps {
  status: 'succeed' | 'fail';
  command: string;
  logs: LogEntry[];
}

export const CommandSummary = ({ status, command, logs }: CommandSummaryProps) => {
  const [isOpen, setIsOpen] = useState(false);

  const isSuccess = status === 'succeed';

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <div className="flex items-center justify-between py-2 px-3 border border-border bg-muted rounded-t-md hover:bg-accent cursor-pointer transition-colors">
          <div className="flex items-center">
            {/* Green checkmark for success, red X for failure */}
            {isSuccess ? (
              <Check className="size-4 text-success mr-2" />
            ) : (
              <XCircle className="size-4 text-destructive mr-2" />
            )}
            <div className="text-xs text-muted-foreground font-mono">{command}</div>
          </div>
          <div className="flex items-center justify-center w-6 h-6">
            {isOpen ? (
              <ChevronDown className="size-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground" />
            )}
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-l border-r border-b border-border bg-muted rounded-b-md">
        <div className="p-3 font-mono text-xs text-foreground">
          <div className="mb-2 text-muted-foreground font-semibold">Command Output:</div>
          <div className="space-y-1">
            {logs.map((log, index) => (
              <div key={index}>
                <LinkifiedText 
                  text={log.line} 
                  linkClassName="text-primary hover:text-primary/80 underline"
                />
              </div>
            ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
