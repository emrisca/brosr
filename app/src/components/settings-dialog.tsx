import { useEffect, useState, type ComponentType } from 'react';
import { Check, Ghost, Monitor, Moon, Palette as PaletteIcon, RefreshCw, Sun, TreePine, Wheat } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { PALETTES, type Mode, type Palette, type Theme } from '@/lib/theme';
import { findUpdate, type Update } from '@/lib/update';
import { cn } from '@/lib/utils';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  theme: Theme;
  mode: Mode;
  palette: Palette;
  onMode: (mode: Mode) => void;
  onPalette: (palette: Palette) => void;
  version: string;
  onUpdate: (update: Update) => void;
};

type CheckState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'current' }
  | { state: 'found'; update: Update }
  | { state: 'error'; reason: string };

export const PALETTE_ICONS: Record<Palette, ComponentType<{ className?: string }>> = {
  classic: PaletteIcon,
  halloween: Ghost,
  thanksgiving: Wheat,
  christmas: TreePine,
};

const MODES: { id: Mode; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
];

export function SettingsDialog({
  open,
  onOpenChange,
  theme,
  mode,
  palette,
  onMode,
  onPalette,
  version,
  onUpdate,
}: Props) {
  const [check, setCheck] = useState<CheckState>({ state: 'idle' });

  // A fresh open starts from a clean line, so an old "up to date" never reads
  // as the answer to a check that did not run.
  useEffect(() => {
    if (open) setCheck({ state: 'idle' });
  }, [open]);

  async function runCheck() {
    setCheck({ state: 'checking' });
    try {
      const next = await findUpdate();
      setCheck(next ? { state: 'found', update: next } : { state: 'current' });
    } catch (reason) {
      setCheck({
        state: 'error',
        reason: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[30rem]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Appearance and updates for this app.</DialogDescription>
        </DialogHeader>

        <section aria-labelledby="settings-appearance" className="flex flex-col gap-2">
          <h3 id="settings-appearance" className="text-xs font-medium">
            Appearance
          </h3>

          <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-1.5">
            {PALETTES.map((entry) => {
              const Icon = PALETTE_ICONS[entry.id];
              const active = entry.id === palette;
              const [bg, card, primary] = entry.swatch[theme];
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onPalette(entry.id)}
                  className={cn(
                    'relative flex items-center gap-2 rounded-md border p-1.5 text-left transition-colors outline-none hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    active ? 'border-ring bg-accent/40' : 'border-border'
                  )}
                >
                  <span
                    className="flex h-8 w-10 shrink-0 items-end gap-0.5 overflow-hidden rounded-sm border border-border p-1"
                    style={{ background: bg }}
                    aria-hidden="true"
                  >
                    <span className="h-full flex-1 rounded-[2px]" style={{ background: card }} />
                    <span className="h-1/2 w-2 rounded-[2px]" style={{ background: primary }} />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-1 text-xs font-medium">
                      <Icon className="size-3 text-brand" />
                      {entry.name}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {entry.blurb}
                    </span>
                  </span>
                  {active ? (
                    <Check className="absolute top-1 right-1 size-3 text-brand" aria-hidden="true" />
                  ) : null}
                </button>
              );
            })}
          </div>

          <div
            role="radiogroup"
            aria-label="Mode"
            className="grid grid-cols-3 gap-0.5 rounded-md border border-border p-0.5"
          >
            {MODES.map((entry) => {
              const Icon = entry.icon;
              const active = entry.id === mode;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onMode(entry.id)}
                  className={cn(
                    'flex h-7 items-center justify-center gap-1.5 rounded-[5px] text-xs transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  )}
                >
                  <Icon className="size-3.5" />
                  {entry.label}
                </button>
              );
            })}
          </div>
        </section>

        <Separator />

        <section aria-labelledby="settings-updates" className="flex flex-col gap-1.5">
          <h3 id="settings-updates" className="text-xs font-medium">
            Updates
          </h3>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {check.state === 'checking'
                ? 'Checking for updates…'
                : check.state === 'current'
                  ? `You are on the latest version${version ? ` (${version})` : ''}.`
                  : check.state === 'found'
                    ? `Brosr ${check.update.version} is ready to install.`
                    : check.state === 'error'
                      ? 'Could not reach the update server. Check your connection and try again.'
                      : version
                        ? `Brosr ${version}`
                        : 'Brosr'}
            </p>
            {check.state === 'found' ? (
              <Button size="sm" onClick={() => onUpdate(check.update)}>
                Install
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={runCheck}
                disabled={check.state === 'checking'}
              >
                <RefreshCw className={cn(check.state === 'checking' && 'animate-spin')} />
                Check for updates
              </Button>
            )}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
