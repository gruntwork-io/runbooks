import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Check, ChevronDown, ChevronRight, XCircle, AlertTriangle } from "lucide-react"
import { useState } from 'react'
import { LinkifiedText } from "@/components/shared/LinkifiedText"
import type { LogEntry } from "@/hooks/useApiExec"

export interface CheckSummaryProps {
  status: 'success' | 'warn' | 'fail';
  summary: string;
  logs: LogEntry[];
}

export const CheckSummary = ({ status, summary, logs }: CheckSummaryProps) => {
  const [isOpen, setIsOpen] = useState(false);

  const statusConfig = {
    success: { icon: Check, color: 'text-success', bgColor: 'bg-success-muted' },
    fail: { icon: XCircle, color: 'text-destructive', bgColor: 'bg-destructive-muted' },
    warn: { icon: AlertTriangle, color: 'text-warning', bgColor: 'bg-warning-muted' }
  };
  
  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <div className="flex items-center justify-between p-2 border border-border bg-muted rounded-t-md hover:bg-accent cursor-pointer transition-colors">
          <div className="flex items-center">
            <Icon className={`size-4 ${config.color} mr-2`} />
            <div className="text-xs text-muted-foreground">{summary}</div>
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
          <div className="mb-2 text-muted-foreground font-semibold">Check Logs:</div>
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
