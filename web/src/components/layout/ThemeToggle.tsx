import { Sun, Moon, Monitor, type LucideProps } from 'lucide-react';
import type { ComponentType } from 'react';
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '../ui/dropdown-menu';
import { useTheme } from '@/contexts/useTheme';
import type { Theme } from '@/contexts/ThemeContext.types';

const OPTIONS: { value: Theme; label: string; icon: ComponentType<LucideProps> }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/**
 * Theme picker for the Header's Menu dropdown. Renders a labeled radio group of
 * Light / Dark / System; must be placed inside a <DropdownMenuContent>.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <>
      <DropdownMenuLabel>Theme</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={theme}
        onValueChange={(value) => setTheme(value as Theme)}
      >
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuRadioItem key={value} value={value}>
            <Icon className="size-4" />
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}
