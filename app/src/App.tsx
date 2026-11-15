import { useEffect, useState, type MouseEvent } from 'react';
import { Users } from 'lucide-react';
import { Brand } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { StepRail } from '@/components/step-rail';
import { ThemeToggle } from '@/components/theme-toggle';
import { UpdateDialog } from '@/components/update-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Browsers } from '@/screens/browsers';
import { Prepare } from '@/screens/prepare';
import { FriendsDialog } from '@/screens/friends';
import { Room } from '@/screens/room';
import { Welcome } from '@/screens/welcome';
import { useTheme } from '@/lib/theme';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { status, type Browser, type Run } from '@/lib/host';
import { checkForUpdate, skip, skipped, type Update } from '@/lib/update';

type Step = 'welcome' | 'browsers' | 'prepare' | 'room';

const INDEX: Record<Step, number> = {
  welcome: 0,
  browsers: 1,
  prepare: 2,
  room: 3,
};

const NAME_KEY = 'brosr-name';

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
  const [browser, setBrowser] = useState<Browser | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [friendsOpen, setFriendsOpen] = useState(false);

  // A room can outlive the window. On launch, adopt the run that is already
  // going instead of asking a second time.
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

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div className="brosr-aurora" aria-hidden="true" />

      {/* The window has no title bar. The top strip is the drag area, and the
          inset keeps the mark and the controls clear of the traffic lights. */}
      <header
        onMouseDown={drag}
        className="relative flex items-center justify-between gap-2 px-2.5 pt-8 pb-2.5"
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
          <StepRail current={INDEX[step]} />
          <ThemeToggle theme={theme} onToggle={toggle} />
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
                onName={setName}
                onNext={() => setStep('browsers')}
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

      <footer className="relative flex items-center justify-end gap-2 p-2.5">
        <p className="font-mono text-xs text-muted-foreground">127.0.0.1</p>
      </footer>

      <FriendsDialog
        open={friendsOpen}
        onOpenChange={setFriendsOpen}
        run={run}
        browserId={browser?.id}
      />
      <UpdateDialog update={update} open={updateOpen} onLater={later} />
    </div>
  );
}
