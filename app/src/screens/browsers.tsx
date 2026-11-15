import { useCallback, useEffect, useState } from 'react';
import { Check, RotateCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { detect, type Browser } from '@/lib/host';

type Props = {
  selected: Browser | null;
  onSelect: (entry: Browser) => void;
  onContinue: () => void;
  onBack: () => void;
};

type Phase = 'loading' | 'ready' | 'error';

export function Browsers({ selected, onSelect, onContinue, onBack }: Props) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [browsers, setBrowsers] = useState<Browser[]>([]);
  const [error, setError] = useState('');

  const scan = useCallback(async () => {
    setPhase('loading');
    setError('');
    try {
      const result = await detect();
      setBrowsers(result.browsers);
      setPhase('ready');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    scan();
  }, [scan]);

  return (
    <div className="flex flex-col gap-2.5">
      <h1 className="text-xl font-medium tracking-tight">Choose a browser</h1>

      {phase === 'loading' ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
          <span className="sr-only">Looking for browsers</span>
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className="flex items-center justify-between gap-2 rounded-md border border-border p-2"
            >
              <Skeleton className="h-4 w-[9rem]" />
              <Skeleton className="h-5 w-[3rem] rounded-full" />
            </div>
          ))}
        </div>
      ) : null}

      {phase === 'error' ? (
        <div className="flex flex-col gap-2 rounded-md bg-muted p-2.5">
          <p className="text-sm font-medium">The scan did not finish</p>
          <p className="text-xs text-muted-foreground">{error}</p>
          <Button variant="secondary" size="sm" onClick={scan} className="self-start">
            <RotateCw />
            Scan again
          </Button>
        </div>
      ) : null}

      {phase === 'ready' && browsers.length === 0 ? (
        <div className="flex flex-col gap-2 rounded-md bg-muted p-2.5">
          <p className="text-sm font-medium">No browser found</p>
          <p className="max-w-[46ch] text-xs text-muted-foreground">
            Install Firefox, Zen, Brave or Chromium, then scan again.
          </p>
          <Button variant="secondary" size="sm" onClick={scan} className="self-start">
            <RotateCw />
            Scan again
          </Button>
        </div>
      ) : null}

      {phase === 'ready' && browsers.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {browsers.map((entry) => {
            const active = selected?.id === entry.id;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => onSelect(entry)}
                  disabled={!entry.supported}
                  aria-pressed={active}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-md border border-border p-2 text-left transition-colors',
                    active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                    !entry.supported && 'opacity-60'
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                    <span className="truncate">{entry.name}</span>
                    {active ? <Check className="size-4" aria-hidden="true" /> : null}
                  </span>
                  <Badge variant={entry.supported ? 'secondary' : 'outline'} className="shrink-0">
                    {entry.supported
                      ? entry.version
                        ? `v${entry.version}`
                        : 'Ready'
                      : entry.reason || 'Unsupported'}
                  </Badge>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={scan} disabled={phase === 'loading'}>
            <RotateCw />
            Rescan
          </Button>
          <Button onClick={onContinue} disabled={!selected?.supported}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
