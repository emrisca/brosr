import { useEffect, useState, type ReactNode } from 'react';
import { Check, Copy, DoorOpen } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { address, status, stop, type Run, type Status } from '@/lib/host';

type Props = {
  run: Run;
  onLeave: () => void;
};

function Dot({ on, className }: { on: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        on ? 'bg-brand' : 'bg-muted-foreground',
        className
      )}
    />
  );
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-muted p-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">{children}</div>
    </div>
  );
}

export function Room({ run, onLeave }: Props) {
  const [live, setLive] = useState<Status | null>(null);
  const [me, setMe] = useState('');
  const [copied, setCopied] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState(false);
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

  useEffect(() => {
    let open = true;
    address()
      .then((answer) => {
        if (open) setMe(answer.address);
      })
      .catch(() => {
        if (open) setMe('');
      });
    return () => {
      open = false;
    };
  }, []);

  const relayReady = Boolean(live?.relayReady);
  const browserOpen = Boolean(live?.browserAlive);
  const peers = live?.peers ?? 0;
  const localOnly = me.startsWith('127.0.0.1');
  const relayHost = live?.host || run.host;
  const relayAddress = relayHost.includes(':')
    ? `[${relayHost}]:${run.port}`
    : `${relayHost}:${run.port}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(run.invite);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('Select the link and press Command C to copy it.');
    }
  }

  async function copyAddress() {
    if (!me) return;
    try {
      await navigator.clipboard.writeText(me);
      setCopiedAddress(true);
      window.setTimeout(() => setCopiedAddress(false), 1600);
    } catch {
      setError('Select the address and press Command C to copy it.');
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
        <div className="min-w-0">
          <h1 className="text-xl font-medium tracking-tight">Room open</h1>
          <p className="truncate font-mono text-xs text-muted-foreground">{run.room}</p>
        </div>
        <Badge variant={relayReady ? 'default' : 'secondary'} className="shrink-0">
          <Dot on={relayReady} className={relayReady ? 'bg-primary-foreground' : undefined} />
          {relayReady ? 'Live' : 'Starting'}
        </Badge>
      </div>

      <div className="flex flex-col gap-2 rounded-md bg-muted p-2">
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

        <div className="flex flex-col gap-1.5">
          <label htmlFor="lobby" className="text-xs text-muted-foreground">
            Lobby address
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="lobby"
              readOnly
              value={me || 'Reading the address'}
              className="font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={copyAddress}
              disabled={!me}
              className="shrink-0"
            >
              {copiedAddress ? <Check /> : <Copy />}
              {copiedAddress ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {localOnly ? (
            <p className="text-xs text-muted-foreground">Only this machine can reach the room.</p>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Metric label="Relay">
          <Dot on={relayReady} />
          {relayReady ? (
            <span className="truncate" title={relayAddress}>
              {relayAddress}
            </span>
          ) : (
            'Starting'
          )}
        </Metric>
        <Metric label="Browser">
          <Dot on={browserOpen} />
          {browserOpen ? run.browser.name : `${run.browser.name} closed`}
        </Metric>
        <Metric label="People">
          <Dot on={peers > 0} />
          {peers === 1 ? '1 peer' : `${peers} peers`}
        </Metric>
        <Metric label="Add-ons">
          <Dot on={run.extensions > 0} />
          {run.extensions} installed
        </Metric>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex justify-end">
        <Button variant="destructive" onClick={leave} disabled={leaving}>
          <DoorOpen />
          {leaving ? 'Closing' : 'Close room'}
        </Button>
      </div>
    </div>
  );
}
