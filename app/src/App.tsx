import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Minus, Users, X } from 'lucide-react';
import { Brand } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { UpdateDialog } from '@/components/update-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Browsers } from '@/screens/browsers';
import { Prepare } from '@/screens/prepare';
import { FriendsDialog } from '@/screens/friends';
import { JoinDialog } from '@/screens/join';
import { Room } from '@/screens/room';
import { Welcome } from '@/screens/welcome';
import { InviteBanner } from '@/components/invite-banner';
import { useTheme } from '@/lib/theme';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { friends as listFriends, status, type Browser, type Invite, type Run } from '@/lib/host';
import { checkForUpdate, skip, skipped, type Update } from '@/lib/update';

type Step = 'welcome' | 'browsers' | 'prepare' | 'room';

const NAME_KEY = 'brosr-name';
const ROOM_NAME_KEY = 'brosr-room-name';

export default function App() {
  const { theme, toggle } = useTheme();
  const [step, setStep] = useState<Step>('welcome');
  const [booting, setBooting] = useState(true);
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) || 'Host';
    } catch {
      return 'Host';
    }
  });
  const [roomName, setRoomName] = useState(() => {
    try {
      return localStorage.getItem(ROOM_NAME_KEY) || 'Movie night';
    } catch {
      return 'Movie night';
    }
  });
  const [browser, setBrowser] = useState<Browser | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [version, setVersion] = useState('');
  const seenInvites = useRef<Set<string>>(new Set());

  // A room can outlive the window. On launch, adopt the run that is already
  // going instead of asking a second time.
  // The running build is the only place a version can come from. A browser
  // preview has no Tauri app to ask, so the stamp stays hidden there.
  useEffect(() => {
    let live = true;
    getVersion()
      .then((next) => {
        if (live) setVersion(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    status()
      .then((state) => {
        if (!live) return;
        if ('invite' in state && state.running) {
          setRun(state);
          setStep('room');
        }
      })
      .catch(() => {})
      .finally(() => {
        if (live) setBooting(false);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      // A refused store costs the next launch only.
    }
  }, [name]);

  useEffect(() => {
    try {
      localStorage.setItem(ROOM_NAME_KEY, roomName);
    } catch {
      // A refused store costs the next launch only.
    }
  }, [roomName]);

  // The lobby has to listen while the app is open, not only while the friends
  // dialog is. This poll starts it and turns a fresh invite into one banner.
  // An invite that is answered or withdrawn elsewhere drops off the list here.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const next = await listFriends();
        if (!live) return;
        setInvite((current) =>
          current && !next.invites.some((entry) => entry.id === current.id) ? null : current
        );
        const fresh = next.invites.find((entry) => !seenInvites.current.has(entry.id));
        if (fresh) {
          seenInvites.current.add(fresh.id);
          setInvite(fresh);
        }
      } catch {
        // A failed poll leaves the last banner alone.
      }
    };
    tick();
    const timer = window.setInterval(tick, 4000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  // One release asks once. Later hides that version until the next release,
  // and the check repeats every six hours for a window left open.
  useEffect(() => {
    let live = true;
    const run = () => {
      checkForUpdate().then((next) => {
        if (!live || !next || skipped(next.version)) return;
        setUpdate(next);
        setUpdateOpen(true);
      });
    };
    run();
    const timer = window.setInterval(run, 6 * 60 * 60 * 1000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  const later = () => {
    if (update) skip(update.version);
    setUpdateOpen(false);
  };

  // The window has no title bar, so the strip at the top is the handle. A
  // declared drag region reaches only the element under the press, and every
  // child of this strip sits under one. The handler runs on the header itself
  // and moves the window for any press that misses a control.
  function drag(event: MouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea')) return;
    event.preventDefault();
    getCurrentWindow().startDragging().catch(() => {});
  }

  function minimizeWindow() {
    getCurrentWindow().minimize().catch(() => {});
  }

  function closeWindow() {
    getCurrentWindow().close().catch(() => {});
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div className="brosr-aurora" aria-hidden="true" />

      {/* The window has no title bar. The top strip is the drag area, and the
          custom controls keep the frameless window usable on Windows. */}
      <header
        onMouseDown={drag}
        className="relative flex items-center justify-between gap-2 px-3 py-2"
      >
        <div className="flex items-center gap-1.5">
          <Brand className="size-5" />
          <span className="text-sm font-medium tracking-tight">Brosr</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Friends"
            onClick={() => setFriendsOpen(true)}
          >
            <Users />
          </Button>
          <ThemeToggle theme={theme} onToggle={toggle} />
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Minimize"
            title="Minimize"
            onClick={minimizeWindow}
          >
            <Minus />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close Brosr"
            title="Close"
            onClick={closeWindow}
          >
            <X />
          </Button>
        </div>
      </header>

      <main className="relative flex flex-1 items-center justify-center">
        {booting ? (
          <div
            className="w-full max-w-[34rem] rounded-lg border border-border bg-card p-2.5"
            aria-busy="true"
            aria-live="polite"
          >
            <span className="sr-only">Checking for a room</span>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-[16rem]" />
              <Skeleton className="h-4 w-[22rem]" />
              <Skeleton className="h-4 w-[12rem]" />
            </div>
          </div>
        ) : (
          <div
            key={step}
            className="brosr-step w-full max-w-[34rem] rounded-lg border border-border bg-card p-2.5"
          >
            {step === 'welcome' ? (
              <Welcome
                name={name}
                roomName={roomName}
                onName={setName}
                onRoomName={setRoomName}
                onNext={() => setStep('browsers')}
                onJoin={() => setJoinOpen(true)}
                onFriends={() => setFriendsOpen(true)}
              />
            ) : null}

            {step === 'browsers' ? (
              <Browsers
                selected={browser}
                onSelect={setBrowser}
                onContinue={() => setStep('prepare')}
                onBack={() => setStep('welcome')}
              />
            ) : null}

            {step === 'prepare' && browser ? (
              <Prepare
                browser={browser}
                name={name}
                roomName={roomName}
                onReady={(next) => {
                  setRun(next);
                  setStep('room');
                }}
                onBack={() => setStep('browsers')}
              />
            ) : null}

            {step === 'room' && run ? (
              <Room
                run={run}
                onLeave={() => {
                  setRun(null);
                  setStep('browsers');
                }}
              />
            ) : null}
          </div>
        )}
      </main>

      {invite ? (
        <InviteBanner
          invite={invite}
          browserId={browser?.id}
          name={name}
          onClose={() => setInvite(null)}
        />
      ) : null}

      <JoinDialog open={joinOpen} onOpenChange={setJoinOpen} name={name} />
      <FriendsDialog
        open={friendsOpen}
        onOpenChange={setFriendsOpen}
        run={run}
        browserId={browser?.id}
        name={name}
      />
      <UpdateDialog update={update} open={updateOpen} onLater={later} />

      {version ? (
        <span
          className="pointer-events-none absolute right-3 bottom-2 font-mono text-[11px] text-muted-foreground"
          title={`Brosr ${version}`}
        >
          v{version}
        </span>
      ) : null}
    </div>
  );
}
