import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Theme } from '@/lib/theme';

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onToggle}
      aria-label={`Use ${next} mode`}
      title={`Use ${next} mode`}
    >
      {theme === 'dark' ? <Sun /> : <Moon />}
    </Button>
  );
}
