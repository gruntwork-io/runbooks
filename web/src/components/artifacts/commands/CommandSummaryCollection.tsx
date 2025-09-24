import { CommandSummary, type CommandSummaryProps } from './CommandSummary'

interface CommandSummaryCollectionProps {
  data: CommandSummaryProps[];
  className?: string;
}

export const CommandSummaryCollection = ({ data, className = "" }: CommandSummaryCollectionProps) => {
  return (
    <div className={`p-4 w-full min-h-[200px] ${className}`}>
      <div className="space-y-3">
        {data.map((command, index) => (
          <CommandSummary
            key={index}
            status={command.status}
            command={command.command}
            logs={command.logs}
          />
        ))}
      </div>
    </div>
  );
}
