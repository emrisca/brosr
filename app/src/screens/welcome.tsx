import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Props = {
  name: string;
  onName: (value: string) => void;
  onNext: () => void;
};

export function Welcome({ name, onName, onNext }: Props) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-xl font-medium tracking-tight">A room is a page you share.</h1>
        <p className="max-w-[46ch] text-sm text-muted-foreground">
          Brosr opens the same page in every window. Cursors, scroll and playback stay
          together. Nothing leaves this Mac.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="room-name" className="text-xs text-muted-foreground">
          Your name in the room
        </label>
        <Input
          id="room-name"
          value={name}
          onChange={(event) => onName(event.target.value)}
          placeholder="Host"
          autoComplete="off"
          maxLength={24}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Takes about a minute.</p>
        <Button onClick={onNext} disabled={!name.trim()}>
          Find my browsers
          <ArrowRight />
        </Button>
      </div>
    </div>
  );
}
