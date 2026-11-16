import { ArrowRight, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Props = {
  name: string;
  roomName: string;
  onName: (value: string) => void;
  onRoomName: (value: string) => void;
  onNext: () => void;
  onJoin: () => void;
  onFriends: () => void;
};

export function Welcome({
  name,
  roomName,
  onName,
  onRoomName,
  onNext,
  onJoin,
  onFriends,
}: Props) {
  return (
    <div className="flex flex-col gap-2.5">
      <h1 className="text-xl font-medium tracking-tight">Start a room</h1>

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
        <label htmlFor="room-name" className="text-xs text-muted-foreground">
          Room name
        </label>
        <Input
          id="room-name"
          value={roomName}
          onChange={(event) => onRoomName(event.target.value)}
          placeholder="Movie night"
          autoComplete="off"
          maxLength={48}
        />
      </div>

      {/* Two ways in, the same size. Hosting opens the browser steps and
          joining takes the invite link. */}
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={onNext} disabled={!name.trim() || !roomName.trim()}>
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
