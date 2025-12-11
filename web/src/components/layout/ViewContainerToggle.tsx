import React from 'react';
import { cn } from '../../lib/utils';

export interface ViewContainerToggleProps {
  /** The current active view */
  activeView: string;
  /** Callback when the view changes */
  onViewChange: (view: string) => void;
  /** Array of view options with label, value, and optional icon */
  views: Array<{
    label: string;
    value: string;
    icon?: React.ComponentType<{ className?: string }>;
  }>;
  /** Additional CSS classes */
  className?: string;
}

export const ViewContainerToggle: React.FC<ViewContainerToggleProps> = ({
  activeView,
  onViewChange,
  views,
  className
}) => {
  return (
    <div className={cn("flex items-center space-x-1", className)}>
      {views.map((view) => {
        const IconComponent = view.icon;
        return (
          <button
            key={view.value}
            onClick={() => onViewChange(view.value)}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 cursor-pointer",
              activeView === view.value
                ? "bg-white text-gray-900 shadow-sm"
                : "text-gray-600 hover:text-gray-900"
            )}
          >
            {IconComponent && <IconComponent className="size-4" />}
            {view.label}
          </button>
        );
      })}
    </div>
  );
};
