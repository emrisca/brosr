import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { prepare, start, type Browser, type Prepared, type Progress as Stage, type Run } from '@/lib/host';

type Props = {
  browser: Browser;
  name: string;
  roomName: string;
  onReady: (run: Run) => void;
  onBack: () => void;
};

type Phase = 'working' | 'ready' | 'starting' | 'error';

// The development build mounts every screen twice. One build is shared by both
// mounts, so the answer reaches the screen that is still showing instead of
// landing on the copy that was already gone.
const builds = new Map<string, Promise<Prepared>>();

function build(browser: string) {
  let pending = builds.get(browser);
  if (!pending) {
    pending = prepare(browser).catch((cause) => {
      builds.delete(browser);
      throw cause;
    });
    builds.set(browser, pending);
  }
  return pending;
}

export function Prepare({ browser, name, roomName, onReady, onBack }: Props) {
  const [phase, setPhase] = useState<Phase>('working');
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;

    // The listener goes on before the call, because the first stage lands while
    // the build is still running. A listener that arrives late is dropped.
    listen<Stage>('brosr-progress', (event) => {
      if (live) setStage(event.payload);
    }).then((off) => {
      if (live) stop = off;
      else off();
    });

    build(browser.id)
      .then((result) => {
        if (!live) return;
        setPrepared(result);
        setStage({ step: 1, total: 1, label: 'Browser profile ready' });
        setPhase('ready');
      })
      .catch((cause) => {
        if (!live) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setPhase('error');
      });

    return () => {
      live = false;
      stop?.();
    };
  }, [browser.id]);

  async function begin() {
    setPhase('starting');
    setError('');
    try {
      const run = await start(
        browser.id,
        name.trim() || 'Host',
        roomName.trim() || 'Room'
      );
      onReady(run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase('ready');
    }
  }

  const percent = stage && stage.total > 0 ? Math.round((stage.step / stage.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-2.5">
      <h1 className="text-xl font-medium tracking-tight">Setting up your room</h1>

      <div className="flex flex-col gap-2 rounded-md bg-muted p-2">
        {phase === 'working' ? (
          <div className="flex flex-col gap-1.5" aria-live="polite">
            <div className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
              <span className="text-sm">{stage ? stage.label : 'Starting the build'}</span>
              {stage ? (
                <span className="ml-auto font-mono text-xs text-muted-foreground">
                  {stage.step}/{stage.total}
                </span>
              ) : null}
            </div>
            <Progress value={percent} aria-label="Profile setup" />
          </div>
        ) : null}

        {prepared ? (
          <>
            <div className="flex items-center gap-1.5 text-sm">
              <Check className="size-4 text-brand" aria-hidden="true" />
              Browser profile
            </div>
            <Separator />
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm">
                <Check className="size-4 text-brand" aria-hidden="true" />
                Add-ons
              </span>
              <span className="text-xs text-muted-foreground">
                {prepared.extensions} {prepared.extensions === 1 ? 'add-on' : 'add-ons'}
              </span>
            </div>
            <Separator />
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm">
                <Check className="size-4 text-brand" aria-hidden="true" />
                Bridge
              </span>
              <span className="text-xs text-muted-foreground">
                {prepared.bridge.version ? `v${prepared.bridge.version}` : 'Installed'}
              </span>
            </div>
          </>
        ) : null}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" onClick={onBack} disabled={phase === 'starting'}>
          Back
        </Button>
        <Button
          onClick={begin}
          disabled={phase !== 'ready' || !prepared}
          aria-busy={phase === 'starting'}
        >
          {phase === 'starting' ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              Starting the room
            </>
          ) : (
            'Start the room'
          )}
        </Button>
      </div>
    </div>
  );
}
