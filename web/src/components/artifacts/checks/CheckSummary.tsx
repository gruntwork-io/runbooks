import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Check, ChevronDown, ChevronRight, XCircle, AlertTriangle } from "lucide-react"
import { useState } from 'react'
import { LinkifiedText } from "@/components/shared/LinkifiedText"

export interface CheckSummaryProps {
  status: 'success' | 'warn' | 'fail';
  summary: string;
  logs: string[];
}

export const CheckSummary = ({ status, summary, logs }: CheckSummaryProps) => {
  const [isOpen, setIsOpen] = useState(false);

  const statusConfig = {
    success: { icon: Check, color: 'text-green-500', bgColor: 'bg-green-50' },
    fail: { icon: XCircle, color: 'text-red-500', bgColor: 'bg-red-50' },
    warn: { icon: AlertTriangle, color: 'text-yellow-700', bgColor: 'bg-yellow-50' }
  };
  
  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <div className="flex items-center justify-between p-2 border border-gray-300 bg-gray-100 rounded-t-md hover:bg-gray-200 cursor-pointer transition-colors">
          <div className="flex items-center">
            <Icon className={`size-4 ${config.color} mr-2`} /> 
            <div className="text-xs text-gray-600">{summary}</div>
          </div>
          <div className="flex items-center justify-center w-6 h-6">
            {isOpen ? (
              <ChevronDown className="size-4 text-gray-500" />
            ) : (
              <ChevronRight className="size-4 text-gray-500" />
            )}
          </div>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-l border-r border-b border-gray-300 bg-gray-50 rounded-b-md">
        <div className="p-3 font-mono text-xs text-gray-700">
          <div className="mb-2 text-gray-600 font-semibold">Check Logs:</div>
          <div className="space-y-1">
            {logs.map((log, index) => (
              <div key={index}>
                <LinkifiedText 
                  text={log} 
                  linkClassName="text-blue-600 hover:text-blue-500 underline"
                />
              </div>
            ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
