import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, Send, Trash2, UserPlus } from 'lucide-react';
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
import {
  addFriend,
  answerInvite,
  friends as listFriends,
  removeFriend,
  sendInvite,
  type FriendsState,
  type Invite,
  type Run,
} from '@/lib/host';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: Run | null;
  browserId?: string;
};

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

export function FriendsDialog({ open, onOpenChange, run, browserId }: Props) {
  const [state, setState] = useState<FriendsState | null>(null);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await listFriends());
    } catch (cause) {
      setError(message(cause));
    }
  }, []);

  // The lobby answers a friend on its own. A poll keeps the inbox current while
  // the dialog is open, and stops as soon as it closes.
  useEffect(() => {
    if (!open) return;
    let live = true;
    const tick = async () => {
      try {
        const next = await listFriends();
        if (live) setState(next);
      } catch {
        // A failed poll leaves the last list on screen.
      }
    };
    tick();
    const timer = window.setInterval(tick, 5000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [open]);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = address.trim();
    if (!value) return;
    setBusy('add');
    setError('');
    setNotice('');
    try {
      const next = await addFriend(value, '');
      setState(next);
      setAddress('');
      setNotice('Friend added.');
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy('');
    }
  }

  async function copyMe() {
    if (!state?.me) return;
    try {
      await navigator.clipboard.writeText(state.me);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('Select the address and press Command C to copy it.');
    }
  }

  async function send(friend: FriendsState['friends'][number]) {
    setBusy(friend.address);
    setError('');
    setNotice('');
    try {
      setState(await sendInvite(friend.address));
      setNotice(`Invite sent to ${friend.name}.`);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy('');
    }
  }

  async function drop(friend: FriendsState['friends'][number]) {
    setBusy(friend.address);
    setError('');
    setNotice('');
    try {
      setState(await removeFriend(friend.address));
      setNotice(`Removed ${friend.name}.`);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy('');
    }
  }

  async function answer(invite: Invite, accept: boolean) {
    setBusy(invite.id);
    setError('');
    setNotice('');
    try {
      const next = await answerInvite(invite.id, accept, browserId);
      setState(next);
      if (!accept) {
        setNotice('Invite declined.');
      } else if (next.joined) {
        setNotice(`Room open in ${next.joined.browser.name}.`);
      } else {
        setNotice('Room open.');
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy('');
    }
  }

  const friends = state?.friends ?? [];
  const invites = state?.invites ?? [];
  const listening = Boolean(state?.lobby.running);
  const localOnly = state?.me.startsWith('127.') || state?.me.startsWith('localhost');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[30rem]">
        <DialogHeader>
          <DialogTitle>Friends</DialogTitle>
          <DialogDescription>
            Invites stay on this machine, your local network or your tailnet. Nothing is sent
            to the internet.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Your lobby address</span>
            <Badge variant={listening ? 'default' : 'secondary'} className="shrink-0">
              {listening ? 'Listening' : 'Off'}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={state?.me ?? 'Starting the lobby'}
              aria-label="Your lobby address"
              className="font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={copyMe}
              disabled={!state?.me}
              className="shrink-0"
            >
              {copied ? <Check /> : <Copy />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Send this to a friend. It is the address they add to reach your invites.
          </p>
        </div>

        {localOnly ? (
          <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
            This machine has no tailnet address, so these invites work here only. Join a
            tailnet to reach a friend.
          </p>
        ) : null}

        <Separator />

        <form onSubmit={add} className="flex flex-col gap-1.5">
          <label htmlFor="friend-address" className="text-xs font-medium">
            Add a friend
          </label>
          <div className="flex items-center gap-1.5">
            <Input
              id="friend-address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="100.64.0.7:8790"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
            />
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              className="shrink-0"
              disabled={busy === 'add' || !address.trim()}
            >
              <UserPlus />
              {busy === 'add' ? 'Adding' : 'Add'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Paste the address your friend copied. Leave the port off to use 8790.
          </p>
        </form>

        <div className="flex max-h-40 flex-col gap-1.5 overflow-y-auto">
          {friends.length === 0 ? (
            <p className="text-xs text-muted-foreground">No friends on this list yet.</p>
          ) : (
            friends.map((friend) => (
              <div
                key={friend.address}
                className="flex items-center justify-between gap-2 rounded-md bg-muted p-1.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">{friend.name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {friend.address}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => send(friend)}
                    disabled={!run || busy === friend.address}
                  >
                    <Send />
                    {busy === friend.address ? 'Sending' : 'Invite'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${friend.name}`}
                    onClick={() => drop(friend)}
                    disabled={busy === friend.address}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        {!run ? (
          <p className="text-xs text-muted-foreground">Open a room to send an invite.</p>
        ) : null}

        <Separator />

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">Invites</span>
          {invites.length === 0 ? (
            <p className="text-xs text-muted-foreground">No invites waiting.</p>
          ) : (
            invites.map((invite) => (
              <div
                key={invite.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border p-1.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">{invite.name} invited you</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {invite.room}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="xs"
                    onClick={() => answer(invite, true)}
                    disabled={busy === invite.id}
                  >
                    <Check />
                    {busy === invite.id ? 'Opening' : 'Accept'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => answer(invite, false)}
                    disabled={busy === invite.id}
                  >
                    Decline
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
          <Button variant="secondary" size="sm" onClick={load}>
            Refresh
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
