import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ChevronDown, ChevronRight, XCircle, Check } from "lucide-react"
import { useState } from 'react'

export interface CommandSummaryProps {
  status: 'succeed' | 'fail';
  command: string;
  logs: string[];
}

export const CommandSummary = ({ status, command, logs }: CommandSummaryProps) => {
  const [isOpen, setIsOpen] = useState(false);

  const isSuccess = status === 'succeed';

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <div className="flex items-center justify-between py-2 px-3 border border-gray-300 bg-gray-100 rounded-t-md hover:bg-gray-200 cursor-pointer transition-colors">
          <div className="flex items-center">
            {/* Green checkmark for success, red X for failure */}
            {isSuccess ? (
              <Check className="size-4 text-green-500 mr-2" />
            ) : (
              <XCircle className="size-4 text-red-500 mr-2" />
            )}
            <div className="text-xs text-gray-600 font-mono">{command}</div>
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
          <div className="mb-2 text-gray-600 font-semibold">Command Output:</div>
          <div className="space-y-1">
            {logs.map((log, index) => (
              <div key={index}>{log}</div>
            ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
