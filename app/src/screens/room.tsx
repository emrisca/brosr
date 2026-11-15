import { useEffect, useState } from 'react';
import { Check, Copy, DoorOpen } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { status, stop, type Run, type Status } from '@/lib/host';

type Props = {
  run: Run;
  onLeave: () => void;
};

function Dot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn('size-1.5 rounded-full', on ? 'bg-brand' : 'bg-muted-foreground')}
    />
  );
}

export function Room({ run, onLeave }: Props) {
  const [live, setLive] = useState<Status | null>(null);
  const [copied, setCopied] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let open = true;
    const tick = async () => {
      try {
        const next = await status();
        if (open) setLive('relayReady' in next ? next : null);
      } catch {
        if (open) setLive(null);
      }
    };
    tick();
    const timer = setInterval(tick, 3000);
    return () => {
      open = false;
      clearInterval(timer);
    };
  }, []);

  const relayReady = Boolean(live?.relayReady);
  const browserOpen = Boolean(live?.browserAlive);
  const peers = live?.peers ?? 0;

  async function copy() {
    try {
      await navigator.clipboard.writeText(run.invite);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('Select the link and press Command C to copy it.');
    }
  }

  async function leave() {
    setLeaving(true);
    setError('');
    try {
      await stop();
      onLeave();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setLeaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-2">
        <h1 className="text-xl font-medium tracking-tight">Your room is open</h1>
        <Badge variant={relayReady ? 'default' : 'secondary'} className="shrink-0">
          <Dot on={relayReady} />
          {relayReady ? 'Live' : 'Starting'}
        </Badge>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="invite" className="text-xs text-muted-foreground">
          Join link
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="invite"
            readOnly
            value={run.invite}
            className="font-mono text-xs"
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button variant="secondary" size="sm" onClick={copy} className="shrink-0">
            {copied ? <Check /> : <Copy />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>

      <Separator />

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm">
            <Dot on={relayReady} />
            Relay
          </span>
          <span className="text-xs text-muted-foreground">
            {relayReady ? `127.0.0.1:${run.port}` : 'Connecting'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm">
            <Dot on={browserOpen} />
            {run.browser.name}
          </span>
          <span className="text-xs text-muted-foreground">
            {browserOpen ? 'Open' : 'Closed'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm">
            <Dot on={run.extensions > 0} />
            Add-ons
          </span>
          <span className="text-xs text-muted-foreground">
            {run.extensions} installed
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm">
            <Dot on={peers > 0} />
            People
          </span>
          <span className="text-xs text-muted-foreground">
            {peers === 1 ? '1 in the room' : `${peers} in the room`}
          </span>
        </div>
      </div>

      <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
        Panel: toolbar icon or{' '}
        {run.browser.family === 'chromium' ? 'Control, Shift and B' : 'Control, Option and B'}
      </p>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex items-center justify-between gap-2">
        <p className="truncate font-mono text-xs text-muted-foreground">{run.room}</p>
        <Button variant="destructive" onClick={leave} disabled={leaving}>
          <DoorOpen />
          {leaving ? 'Closing' : 'Close room'}
        </Button>
      </div>
    </div>
  );
}
