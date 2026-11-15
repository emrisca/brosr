import { ArrowRight, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Props = {
  name: string;
  onName: (value: string) => void;
  onNext: () => void;
  onJoin: () => void;
  onFriends: () => void;
};

export function Welcome({ name, onName, onNext, onJoin, onFriends }: Props) {
  return (
    <div className="flex flex-col gap-2.5">
      <h1 className="text-xl font-medium tracking-tight">A room is a page you share.</h1>

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

      {/* Two ways in, the same size. Hosting opens the browser steps and
          joining takes the invite link. */}
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={onNext} disabled={!name.trim()}>
          Host a room
          <ArrowRight />
        </Button>
        <Button variant="secondary" onClick={onJoin}>
          Join a room
        </Button>
      </div>

      <Button variant="ghost" size="sm" onClick={onFriends} className="self-start">
        <UserPlus />
        Add a friend
      </Button>
    </div>
  );
}
