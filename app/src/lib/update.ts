import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export type { Update };

// How long a release stays quiet after someone chooses Later. A new release
// replaces the value, so the next one asks again.
const SKIP_KEY = 'brosr-update-skipped';

// Offline and rate limited runs both land here. An update check must never
// block setup, so every failure answers the same way.
export async function checkForUpdate(): Promise<Update | null> {
  try {
    return await check({ timeout: 12000 });
  } catch {
    return null;
  }
}

export function skipped(version: string): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === version;
  } catch {
    return false;
  }
}

export function skip(version: string): void {
  try {
    localStorage.setItem(SKIP_KEY, version);
  } catch {
    // A refused store asks again next launch. That costs one dialog.
  }
}

// The progress callback gets a whole percent, or null while the size is
// unknown. The install replaces the app bundle and then restarts it.
export async function installUpdate(
  update: Update,
  onProgress: (percent: number | null) => void
): Promise<void> {
  let total = 0;
  let done = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? 0;
    } else if (event.event === 'Progress') {
      done += event.data.chunkLength;
      onProgress(total > 0 ? Math.min(99, Math.round((done / total) * 100)) : null);
    } else {
      onProgress(100);
    }
  });
  await relaunch();
}
