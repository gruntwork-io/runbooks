import { CheckSummary, type CheckSummaryProps } from './CheckSummary'

interface CheckSummaryCollectionProps {
  data: CheckSummaryProps[];
  className?: string;
}

export const CheckSummaryCollection = ({ data, className = "" }: CheckSummaryCollectionProps) => {
  return (
    <div className={`p-4 w-full min-h-[200px] ${className}`}>
      <div className="space-y-3">
        {data.map((check, index) => (
          <CheckSummary
            key={index}
            status={check.status}
            summary={check.summary}
            logs={check.logs}
          />
        ))}
      </div>
    </div>
  );
}
