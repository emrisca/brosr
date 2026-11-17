import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { answerInvite, type Invite } from '@/lib/host';

type Props = {
  invite: Invite;
  browserId?: string;
  name?: string;
  onClose: () => void;
};

// A friend's invite reaches the lobby while the app is open. The banner is the
// short window to take it, and it closes on its own so an ignored invite does
// not sit over the screen.
export function InviteBanner({ invite, browserId, name, onClose }: Props) {
  const [busy, setBusy] = useState<'accept' | 'decline' | ''>('');
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(onClose, 15000);
    return () => window.clearTimeout(timer);
  }, [invite.id]);

  async function answer(accept: boolean) {
    setBusy(accept ? 'accept' : 'decline');
    setError('');
    try {
      await answerInvite(invite.id, accept, browserId, name);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy('');
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-x-2.5 bottom-2.5 z-40 flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5 shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{invite.name} invited you</p>
          <p className="text-xs text-muted-foreground">
            Room {invite.room}. Closes in 15 seconds.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss invite"
          onClick={onClose}
          disabled={busy !== ''}
        >
          <X />
        </Button>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex items-center justify-end gap-1.5">
        <Button
          variant="ghost"
          size="xs"
          onClick={() => answer(false)}
          disabled={busy !== ''}
        >
          Decline
        </Button>
        <Button size="xs" onClick={() => answer(true)} disabled={busy !== ''}>
          <Check />
          {busy === 'accept' ? 'Opening' : 'Accept'}
        </Button>
      </div>
    </div>
  );
}
