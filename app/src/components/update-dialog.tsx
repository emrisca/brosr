import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { installUpdate, type Update } from '@/lib/update';

type Props = {
  update: Update | null;
  open: boolean;
  onLater: () => void;
};

// One release, one popup. The install runs in place, so the app restarts into
// the new build and the setup state stays where it was.
export function UpdateDialog({ update, open, onLater }: Props) {
  const [installing, setInstalling] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState('');

  if (!update) return null;

  const install = async () => {
    setInstalling(true);
    setError('');
    setPercent(null);
    try {
      await installUpdate(update, setPercent);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setInstalling(false);
      setPercent(null);
    }
  };

  const close = (next: boolean) => {
    if (!next && !installing) onLater();
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent showCloseButton={!installing}>
        <DialogHeader>
          <DialogTitle>Brosr {update.version} is ready</DialogTitle>
          <DialogDescription>
            You are on {update.currentVersion}. The update installs in place, then the app
            restarts.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p role="alert" className="text-xs text-destructive">
            The update did not install. {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onLater} disabled={installing}>
            Later
          </Button>
          <Button size="sm" onClick={install} disabled={installing}>
            {installing
              ? percent === null
                ? 'Installing'
                : `Installing ${percent}%`
              : 'Install and restart'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
