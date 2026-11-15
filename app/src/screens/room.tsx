import { useEffect, useState } from 'react';
import { AppWindow, Check, Copy, DoorOpen } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { showPanel, status, stop, type Run, type Status } from '@/lib/host';

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
  const [showing, setShowing] = useState(false);
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

  // The window belongs to the bridge, so the host opens one tab that asks the
  // bridge to show it again. The tab closes itself once the window is there.
  async function open() {
    setShowing(true);
    setError('');
    try {
      await showPanel();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      window.setTimeout(() => setShowing(false), 1200);
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
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-medium tracking-tight">Your room is open</h1>
          <p className="max-w-[46ch] text-sm text-muted-foreground">
            Send the link to anyone you want in the room. They install Brosr, open the
            link, and land on the same page.
          </p>
        </div>
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

      {run.timings ? (
        <p className="text-xs text-muted-foreground">
          Ready in {(run.timings.totalMs / 1000).toFixed(1)} s. Profile{' '}
          {run.timings.prepareMs} ms{run.timings.reused ? ', cached' : ''}. Relay{' '}
          {run.timings.relayMs} ms. Browser {run.timings.launchMs} ms.
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5 rounded-md bg-muted p-2">
        <p className="text-sm font-medium">The room window lives in the browser</p>
        <p className="text-xs text-muted-foreground">
          Press {run.browser.family === 'chromium' ? 'Control, Shift and B' : 'Control, Option and B'} to
          show it again. The toolbar button does the same.
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={open}
          disabled={!browserOpen || showing}
          className="self-start"
        >
          <AppWindow />
          {showing ? 'Opening' : 'Show window'}
        </Button>
      </div>

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
