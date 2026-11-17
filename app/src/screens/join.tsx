import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight } from 'lucide-react';
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
import { detect, join, type Browser, type Joined } from '@/lib/host';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onJoined: (joined: Joined) => void;
};

// A pasted link is not a page a browser can open on its own. The room needs the
// bridge, and the bridge lives in the profile this app builds, so the link comes
// here and the app starts the browser for it.
export function JoinDialog({ open, onOpenChange, name, onJoined }: Props) {
  const [link, setLink] = useState('');
  const [browsers, setBrowsers] = useState<Browser[]>([]);
  const [browserId, setBrowserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLink('');
    setError('');
    detect()
      .then((result) => {
        if (!live) return;
        const ready = result.browsers.filter((entry) => entry.supported);
        setBrowsers(ready);
        setBrowserId(ready[0]?.id ?? '');
      })
      .catch((cause) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = link.trim();
    if (!value) return;
    setBusy(true);
    setError('');
    try {
      const answer = await join(value, browserId || undefined, name);
      onJoined(answer);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[30rem]">
        <DialogHeader>
          <DialogTitle>Join a room</DialogTitle>
          <DialogDescription>
            Paste an invite link. Brosr opens it in a browser set up for that room.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="invite-link" className="text-xs text-muted-foreground">
              Invite link or code
            </label>
            <Input
              id="invite-link"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              placeholder="http://100.64.0.7:8787/?room=..."
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="join-browser" className="text-xs text-muted-foreground">
              Open in
            </label>
            <select
              id="join-browser"
              value={browserId}
              onChange={(event) => setBrowserId(event.target.value)}
              disabled={browsers.length === 0}
              className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
            >
              {browsers.length === 0 ? <option value="">No browser is ready</option> : null}
              {browsers.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || !link.trim() || !browserId}>
              <ArrowRight />
              {busy ? 'Joining' : 'Join'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
