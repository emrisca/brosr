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
import { join, type Joined } from '@/lib/host';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  browserId?: string;
  browserName?: string;
  onJoined: (joined: Joined) => void;
};

// A pasted link is not a page a browser can open on its own. The room needs the
// bridge, and the bridge lives in the profile this app builds, so the link comes
// here and the app starts the browser for it.
export function JoinDialog({
  open,
  onOpenChange,
  name,
  browserId,
  browserName,
  onJoined,
}: Props) {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setLink('');
    setError('');
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = link.trim();
    if (!value || !browserId) return;
    setBusy(true);
    setError('');
    try {
      const answer = await join(value, browserId, name);
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
            Paste an invite link. Brosr opens it in the browser you chose on the start
            screen.
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

          <p className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
            {browserName
              ? `Open in ${browserName}.`
              : 'Choose a browser on the start screen first.'}
          </p>

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
