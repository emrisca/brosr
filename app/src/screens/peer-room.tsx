import { useEffect, useState, type ReactNode } from 'react';
import { DoorOpen, RotateCw, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import {
  guestPanel,
  reopen,
  status,
  stop,
  type GuestStatus,
  type Joined,
  type PanelPeer,
  type PanelState,
} from '@/lib/host';

type Props = {
  joined: Joined;
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

function PeerRow({ peer, hostId }: { peer: PanelPeer; hostId: string }) {
  const host = !peer.self && peer.id === hostId;
  const label = peer.self ? 'You' : host ? 'Host' : peer.granted ? 'Control' : 'Viewing';
  const detail = peer.self
    ? 'In the room'
    : host
      ? 'Runs this room'
      : peer.granted
        ? 'Can pause and share tabs'
        : 'Following the room';

  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded-md bg-muted p-2">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ background: peer.colour || 'currentColor' }}
          aria-hidden="true"
        />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">
            {peer.name || peer.id}
            {peer.self ? ' (you)' : ''}
          </span>
          <span className="block text-xs text-muted-foreground">{detail}</span>
        </span>
      </div>
      <Badge
        variant={peer.self ? 'secondary' : host ? 'default' : peer.granted ? 'secondary' : 'outline'}
        className="shrink-0"
      >
        {label}
      </Badge>
    </div>
  );
}

export function PeerRoom({ joined, onLeave }: Props) {
  const [live, setLive] = useState<GuestStatus | null>(null);
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [reopening, setReopening] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let open = true;
    const tick = async () => {
      try {
        const next = await status();
        if (open) setLive('joined' in next ? next : null);
      } catch {
        if (open) setLive(null);
      }
      try {
        const next = await guestPanel();
        if (open) setPanel(next);
      } catch {
        if (open) setPanel(null);
      }
    };
    tick();
    const timer = window.setInterval(tick, 3000);
    return () => {
      open = false;
      window.clearInterval(timer);
    };
  }, [joined.peer]);

  const relayReady = Boolean(live?.relayReady);
  const browserOpen = live ? live.browserAlive : true;
  const roomName = panel?.roomName || live?.roomName || joined.roomName || 'Room';
  const hostAddress = `${joined.host.includes(':') ? `[${joined.host}]` : joined.host}:${joined.port}`;
  const people: PanelPeer[] = panel?.peers?.length
    ? panel.peers
    : [{ id: joined.peer, name: joined.name, self: true, granted: false }];
  const peopleCount = Math.max(live?.peers ?? 0, people.length);
  const waiting = Math.max(0, peopleCount - people.length);
  const connection = !live
    ? 'Connecting'
    : relayReady && browserOpen
      ? 'Live'
      : relayReady
        ? 'Browser closed'
        : 'Reconnecting';

  async function openBrowser() {
    setReopening(true);
    setError('');
    setNotice('');
    try {
      const answer = await reopen();
      const next = await status();
      if ('joined' in next) setLive(next);
      setNotice(`${answer.browser.name} is open.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReopening(false);
    }
  }

  async function leave() {
    setLeaving(true);
    setError('');
    setNotice('');
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
          <h1 className="text-xl font-medium tracking-tight">{roomName}</h1>
          <p className="truncate font-mono text-xs text-muted-foreground">{joined.room}</p>
        </div>
        <Badge variant={connection === 'Live' ? 'default' : 'secondary'} className="shrink-0">
          <Dot on={connection === 'Live'} className={connection === 'Live' ? 'bg-primary-foreground' : undefined} />
          {connection}
        </Badge>
      </div>

      <div className="flex flex-col gap-2 rounded-md bg-muted p-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">You are in this room</p>
            <p className="truncate text-sm font-medium">{joined.name}</p>
          </div>
          <Badge variant="outline" className="shrink-0">
            Guest
          </Badge>
        </div>
        <Separator />
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground">Host</span>
          <span className="truncate font-mono text-xs" title={hostAddress}>
            {hostAddress}
          </span>
          <span className="text-muted-foreground">Browser</span>
          <span className="truncate">{joined.browser.name}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Metric label="Relay">
          <Dot on={relayReady} />
          {relayReady ? (
            <span className="truncate" title={hostAddress}>
              {hostAddress}
            </span>
          ) : (
            'Reconnecting'
          )}
        </Metric>
        <Metric label="Browser">
          <Dot on={browserOpen} />
          {browserOpen ? joined.browser.name : `${joined.browser.name} closed`}
        </Metric>
        <Metric label="People">
          <Dot on={peopleCount > 0} />
          {peopleCount === 1 ? '1 person' : `${peopleCount} people`}
        </Metric>
        <Metric label="Connection">
          <Dot on={connection === 'Live'} />
          {connection}
        </Metric>
      </div>

      <section className="flex flex-col gap-1.5">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Users className="size-3.5" aria-hidden="true" />
          People
        </p>
        <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto" aria-live="polite">
          {people.map((peer) => (
            <PeerRow key={peer.id} peer={peer} hostId={panel?.hostId || 'host'} />
          ))}
        </div>
        {waiting > 0 ? (
          <p className="text-xs text-muted-foreground">
            Waiting for {waiting === 1 ? 'one more name' : `${waiting} more names`}.
          </p>
        ) : null}
      </section>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {notice ? (
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <Button variant="secondary" onClick={openBrowser} disabled={reopening || leaving}>
          <RotateCw />
          {reopening ? 'Opening browser' : browserOpen ? 'Reopen browser' : 'Open browser'}
        </Button>
        <Button variant="destructive" onClick={leave} disabled={leaving}>
          <DoorOpen />
          {leaving ? 'Leaving' : 'Leave room'}
        </Button>
      </div>
    </div>
  );
}
