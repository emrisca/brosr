import { ArrowRight, ChevronRight, Loader2, Radar, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Browser, DiscoveredRoom } from '@/lib/host';

type Props = {
  name: string;
  rooms: DiscoveredRoom[];
  discovering: boolean;
  tailnet: boolean;
  joining: string;
  discoveryError: string;
  browsers: Browser[];
  browserId: string;
  detectingBrowsers: boolean;
  browserError: string;
  onBrowser: (id: string) => void;
  onRescan: () => void;
  onName: (value: string) => void;
  onNext: () => void;
  onJoin: () => void;
  onJoinRoom: (room: DiscoveredRoom) => void;
};

export function Welcome({
  name,
  rooms,
  discovering,
  tailnet,
  joining,
  discoveryError,
  browsers,
  browserId,
  detectingBrowsers,
  browserError,
  onBrowser,
  onRescan,
  onName,
  onNext,
  onJoin,
  onJoinRoom,
}: Props) {
  const hasSupported = browsers.some((entry) => entry.supported);

  return (
    <div className="flex flex-col gap-2.5">
      <h1 className="text-xl font-medium tracking-tight">Start or join a room</h1>

      <section className="flex flex-col gap-1.5" aria-labelledby="tailnet-rooms">
        <div className="flex items-center justify-between gap-2">
          <p
            id="tailnet-rooms"
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
          >
            <Radar className="size-3.5" aria-hidden="true" />
            Rooms on your tailnet
          </p>
          {discovering ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              Scanning
            </span>
          ) : null}
        </div>

        {rooms.length ? (
          <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto" aria-live="polite">
            {rooms.map((room) => {
              const busy = joining === room.room;
              return (
                <button
                  key={`${room.address}/${room.room}`}
                  type="button"
                  onClick={() => onJoinRoom(room)}
                  disabled={Boolean(joining)}
                  className="flex w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border p-2 text-left transition-colors hover:bg-accent/40 disabled:cursor-wait disabled:opacity-60"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {room.roomName || 'Room'}
                    </span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {room.address}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    {busy ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      `${room.peers} ${room.peers === 1 ? 'person' : 'people'}`
                    )}
                    <ChevronRight className="size-3.5" aria-hidden="true" />
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground" aria-live="polite">
            {discovering
              ? 'Scanning the tailnet for open rooms.'
              : tailnet
                ? 'No rooms are open right now.'
                : 'No tailnet found. Open Tailscale to see rooms here.'}
          </p>
        )}

        {discoveryError ? <p className="text-xs text-destructive">{discoveryError}</p> : null}
      </section>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="display-name" className="text-xs text-muted-foreground">
          Your name
        </label>
        <Input
          id="display-name"
          value={name}
          onChange={(event) => onName(event.target.value)}
          placeholder="Host"
          autoComplete="off"
          maxLength={24}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="start-browser" className="text-xs text-muted-foreground">
            Browser
          </label>
          <Button
            variant="ghost"
            size="xs"
            onClick={onRescan}
            disabled={detectingBrowsers}
          >
            {detectingBrowsers ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RotateCw className="size-3.5" aria-hidden="true" />
            )}
            {detectingBrowsers ? 'Scanning' : 'Rescan'}
          </Button>
        </div>
        <select
          id="start-browser"
          value={browserId}
          onChange={(event) => onBrowser(event.target.value)}
          disabled={detectingBrowsers || browsers.length === 0}
          className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
        >
          {!browserId ? (
            <option value="">
              {detectingBrowsers
                ? 'Looking for browsers'
                : hasSupported
                  ? 'Choose a browser'
                  : 'No supported browser'}
            </option>
          ) : null}
          {browsers.map((entry) => (
            <option key={entry.id} value={entry.id} disabled={!entry.supported}>
              {entry.name}
              {entry.supported ? '' : ` (${entry.reason || 'unsupported'})`}
            </option>
          ))}
        </select>
        {browserError ? (
          <p className="text-xs text-destructive">{browserError}</p>
        ) : !browserId ? (
          <p className="text-xs text-muted-foreground">
            {hasSupported
              ? 'Choose a browser to host or join a room.'
              : 'Install Firefox, Zen, Brave or Chromium, then rescan.'}
          </p>
        ) : null}
      </div>

      {/* Two ways in, the same size. The browser is chosen here for both, so
          neither path asks on a later screen. */}
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={onNext} disabled={!name.trim() || !browserId}>
          Host a room
          <ArrowRight />
        </Button>
        <Button variant="secondary" onClick={onJoin} disabled={!browserId}>
          Join a room
        </Button>
      </div>
    </div>
  );
}
