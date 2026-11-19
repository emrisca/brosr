import { useEffect, useState } from 'react';
import { Check, Loader2, RefreshCw, Save, Shield, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  roomPanel,
  type PanelAction,
  type PanelState,
  type PanelTab,
  type PanelValues,
} from '@/lib/host';
import { cn } from '@/lib/utils';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function Toggle({
  label,
  note,
  on,
  disabled,
  onChange,
}: {
  label: string;
  note?: string;
  on: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      className={cn(
        'flex items-start justify-between gap-2 rounded-md border border-border p-2',
        disabled ? 'opacity-60' : 'cursor-pointer hover:bg-accent/40'
      )}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {note ? <span className="mt-0.5 block text-xs text-muted-foreground">{note}</span> : null}
      </span>
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="mt-0.5 size-4 shrink-0 accent-primary"
      />
    </label>
  );
}

function tabLabel(tab: PanelTab) {
  try {
    const url = new URL(tab.url);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return tab.url;
  }
}

function pageLabel(key: string | null) {
  if (!key) return 'Not set';
  try {
    const url = new URL(key);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname}`;
  } catch {
    return key;
  }
}

function siteLabel(site: string) {
  try {
    const url = new URL(site);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.hostname.replace(/^www\./, '')}${path === '/' ? '' : path}`;
  } catch {
    return site;
  }
}

export function RoomControls({ open, onOpenChange }: Props) {
  const [state, setState] = useState<PanelState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [nameDirty, setNameDirty] = useState(false);
  const [trustUrl, setTrustUrl] = useState('');
  const [trustDirty, setTrustDirty] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = async (first = false) => {
      if (first) setLoading(true);
      try {
        const next = await roomPanel('status');
        if (!live) return;
        setState(next);
        setError('');
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (live && first) setLoading(false);
      }
    };
    load(true);
    const timer = window.setInterval(() => load(false), 2500);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!state || nameDirty) return;
    setName(state.roomName);
  }, [state?.roomName, nameDirty]);

  useEffect(() => {
    if (!state || trustDirty) return;
    setTrustUrl(state.trustTarget || '');
  }, [state?.trustTarget, trustDirty]);

  async function act(action: PanelAction, values: PanelValues = {}) {
    setBusy(action);
    setError('');
    try {
      const next = await roomPanel(action, values);
      setState(next);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setBusy('');
    }
  }

  async function saveName() {
    const value = name.trim();
    if (!value) return setError('Type a room name first.');
    const next = await act('room-name', { value });
    if (next) setNameDirty(false);
  }

  async function saveTrust() {
    const next = await act('trust', { url: trustUrl.trim() });
    if (next) setTrustDirty(false);
  }

  const peers = state?.peers ?? [];
  const tabs = (state?.tabs ?? []).filter((tab) => !tab.room);
  const forgottenSites = state?.cursorForgot ?? [];
  const cursorSites = [
    ...new Set([...(state?.cursorSites ?? []), ...(state?.cursorSeen ?? [])]),
  ]
    .filter((site) => !forgottenSites.includes(site))
    .sort((a, b) => siteLabel(a).localeCompare(siteLabel(b)));
  const siteOn = (site: string) =>
    state?.cursorSites === null || state?.cursorSites === undefined
      ? true
      : state.cursorSites.includes(site);
  const scrollSites = [
    ...new Set([...(state?.scrollSites ?? []), ...(state?.scrollSeen ?? [])]),
  ].sort((a, b) => siteLabel(a).localeCompare(siteLabel(b)));
  const scrollOn = (site: string) =>
    state?.scrollSites === null || state?.scrollSites === undefined
      ? true
      : state.scrollSites.includes(site);
  const disabled = Boolean(busy);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-[36rem] overflow-hidden">
        <DialogHeader>
          <DialogTitle>Room controls</DialogTitle>
          <DialogDescription>
            Host settings for this room. Cursor cosmetics stay in the browser panel.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[64vh] flex-col gap-3 overflow-y-auto pr-1">
          {loading && !state ? (
            <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
              <span className="sr-only">Reading room controls</span>
              {[0, 1, 2].map((row) => (
                <Skeleton key={row} className="h-10 w-full" />
              ))}
            </div>
          ) : null}

          {!loading && !state && error ? (
            <div className="flex flex-col gap-2 rounded-md bg-muted p-2.5">
              <p className="text-sm font-medium">The room did not answer</p>
              <p className="text-xs text-muted-foreground">{error}</p>
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                onClick={() => {
                  setLoading(true);
                  roomPanel('status')
                    .then((next) => {
                      setState(next);
                      setError('');
                    })
                    .catch((cause) =>
                      setError(cause instanceof Error ? cause.message : String(cause))
                    )
                    .finally(() => setLoading(false));
                }}
              >
                <RefreshCw />
                Try again
              </Button>
            </div>
          ) : null}

          {state ? (
            <>
              <section className="flex flex-col gap-2">
                <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Users className="size-3.5" aria-hidden="true" />
                  People
                </p>
                <div className="flex flex-col gap-1.5">
                  {peers.map((peer) => (
                    <div
                      key={peer.id}
                      className="flex min-w-0 items-center justify-between gap-2 rounded-md bg-muted p-2"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ background: peer.colour || 'currentColor' }}
                          aria-hidden="true"
                        />
                        <span className="truncate text-sm font-medium">
                          {peer.name || peer.id}
                          {peer.self ? ' (you)' : ''}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Badge variant={peer.granted ? 'secondary' : 'outline'}>
                          {peer.granted ? 'Control' : 'No control'}
                        </Badge>
                        {!peer.self ? (
                          <Button
                            size="xs"
                            variant={peer.granted ? 'ghost' : 'secondary'}
                            disabled={disabled}
                            onClick={() =>
                              act('grant', { peerId: peer.id, allowed: !peer.granted })
                            }
                          >
                            {peer.granted ? 'Revoke' : 'Grant'}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Control lets a person pause the film, open tabs, and use the browser. It is
                  per person and can be revoked at any time.
                </p>
              </section>

              <Separator />

              <section className="flex flex-col gap-2">
                <p className="text-xs font-medium text-muted-foreground">Room</p>
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Room name"
                    value={name}
                    maxLength={48}
                    onChange={(event) => {
                      setName(event.currentTarget.value);
                      setNameDirty(true);
                    }}
                    onBlur={() => {
                      if (name.trim() && name.trim() !== state.roomName) saveName();
                    }}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={saveName}
                    disabled={disabled || !nameDirty || !name.trim()}
                  >
                    <Save />
                    Save
                  </Button>
                </div>
              </section>

              <Separator />

              <section className="flex flex-col gap-2">
                <p className="text-xs font-medium text-muted-foreground">Cursor sites</p>
                <p className="text-xs text-muted-foreground">
                  Choose where pointers appear. Canvas and Notes start on; a site joins the
                  list after someone visits it.
                </p>
                {cursorSites.length ? (
                  <div className="flex max-h-40 flex-col gap-1.5 overflow-y-auto">
                    {cursorSites.map((site) => (
                      <label
                        key={site}
                        className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-border p-2 hover:bg-accent/40"
                      >
                        <span className="min-w-0 truncate text-sm" title={site}>
                          {siteLabel(site)}
                        </span>
                        <input
                          type="checkbox"
                          checked={siteOn(site)}
                          disabled={disabled}
                          onChange={() => act('cursor-site', { site, on: !siteOn(site) })}
                          className="size-4 shrink-0 accent-primary"
                        />
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No cursor sites yet.</p>
                )}
                {forgottenSites.length ? (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-xs text-muted-foreground">Removed sites</p>
                    {forgottenSites.map((site) => (
                      <div
                        key={site}
                        className="flex items-center justify-between gap-2 rounded-md bg-muted p-2"
                      >
                        <span className="min-w-0 truncate text-sm" title={site}>
                          {siteLabel(site)}
                        </span>
                        <Button
                          size="xs"
                          variant="secondary"
                          disabled={disabled}
                          onClick={() => act('cursor-site', { site, on: true })}
                        >
                          Restore
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>

              <Separator />

              <section className="flex flex-col gap-2">
                <p className="text-xs font-medium text-muted-foreground">Mirror sites</p>
                <p className="text-xs text-muted-foreground">
                  Choose where the room follows scroll and accepts clicks and typing. A site
                  joins the list after someone visits it.
                </p>
                {scrollSites.length ? (
                  <div className="flex max-h-40 flex-col gap-1.5 overflow-y-auto">
                    {scrollSites.map((site) => (
                      <label
                        key={site}
                        className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-border p-2 hover:bg-accent/40"
                      >
                        <span className="min-w-0 truncate text-sm" title={site}>
                          {siteLabel(site)}
                        </span>
                        <input
                          type="checkbox"
                          checked={scrollOn(site)}
                          disabled={disabled}
                          onChange={() => act('scroll-site', { site, on: !scrollOn(site) })}
                          className="size-4 shrink-0 accent-primary"
                        />
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No sites yet.</p>
                )}
              </section>

              <Separator />

              <section className="flex flex-col gap-2">
                <p className="text-xs font-medium text-muted-foreground">Playback</p>
                <Toggle
                  label="Sync playback"
                  note="This browser follows the room playhead."
                  on={state.sync}
                  disabled={disabled}
                  onChange={(next) => act('set', { key: 'sync', on: next })}
                />
                <Toggle
                  label="Suffer the same fate"
                  note="Pause everyone while the host or a person with control buffers. People without control never hold the room."
                  on={state.sameFate}
                  disabled={disabled}
                  onChange={(next) => act('set', { key: 'fate', on: next })}
                />
                <Toggle
                  label="Action notices"
                  note="Show who paused, played, or sought the film."
                  on={state.notices}
                  disabled={disabled}
                  onChange={(next) => act('set', { key: 'notices', on: next })}
                />
              </section>

              <Separator />

              <section className="flex flex-col gap-2">
                <p className="text-xs font-medium text-muted-foreground">Tabs</p>
                <Toggle
                  label="Share new tabs"
                  note="Send every new browser tab to the room."
                  on={state.auto}
                  disabled={disabled}
                  onChange={(next) => act('set', { key: 'auto', on: next })}
                />
                {tabs.length ? (
                  <div className="flex max-h-40 flex-col gap-1.5 overflow-y-auto">
                    {tabs.map((tab) => (
                      <label
                        key={tab.id}
                        className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-border p-2 hover:bg-accent/40"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm">{tab.title || 'Tab'}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {tabLabel(tab)}
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          checked={Boolean(tab.shared)}
                          disabled={disabled}
                          onChange={() =>
                            act('tab', { tabId: tab.id, shared: !tab.shared })
                          }
                          className="size-4 shrink-0 accent-primary"
                        />
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No other tab can be shared yet.</p>
                )}
              </section>

              <Separator />

              <section className="flex flex-col gap-2">
                <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Shield className="size-3.5" aria-hidden="true" />
                  Trusted typing
                </p>
                <p className="text-xs text-muted-foreground">
                  Typing goes to this page. Leave it empty to type into the room tab.
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Trusted typing page"
                    value={trustUrl}
                    placeholder="https://example.com/page"
                    disabled={!state.trust || disabled}
                    onChange={(event) => {
                      setTrustUrl(event.currentTarget.value);
                      setTrustDirty(true);
                    }}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={saveTrust}
                    disabled={!state.trust || disabled || !trustDirty}
                  >
                    <Check />
                    Set
                  </Button>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  Current: {pageLabel(state.trustTarget)}
                </p>
              </section>

              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </>
          ) : null}
        </div>

        <DialogFooter>
          {busy ? (
            <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Saving
            </span>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
