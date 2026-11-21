import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const SEASONAL = ['halloween', 'thanksgiving', 'christmas'];
const REQUIRED_TOKENS = [
  'color-scheme',
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--border',
  '--input',
  '--ring',
  '--brand',
  '--brand-ink',
  '--aurora-a',
  '--aurora-b',
  '--aurora-c',
];

function extractCssBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css);
  return match ? match[1] : null;
}

test('every seasonal theme defines complete light and dark CSS palettes', () => {
  const css = read('app/src/index.css');
  for (const id of SEASONAL) {
    const light = extractCssBlock(css, `[data-palette="${id}"]`);
    const dark = extractCssBlock(css, `.dark[data-palette="${id}"]`);
    assert.ok(light, `missing light palette block for ${id}`);
    assert.ok(dark, `missing dark palette block for ${id}`);
    assert.match(light, /color-scheme:\s*light;/, `${id} light block must set color-scheme: light`);
    assert.match(dark, /color-scheme:\s*dark;/, `${id} dark block must set color-scheme: dark`);
    for (const token of REQUIRED_TOKENS) {
      assert.ok(light.includes(`${token}:`), `${id} light missing ${token}`);
      assert.ok(dark.includes(`${token}:`), `${id} dark missing ${token}`);
    }
  }
});

test('boot script in app/index.html restores saved palette and light/dark/system mode before paint', () => {
  const html = read('app/index.html');
  const scriptMatch = /<script>\s*([\s\S]*?)\s*<\/script>/.exec(html);
  assert.ok(scriptMatch, 'inline boot script missing from app/index.html');
  const bootCode = scriptMatch[1];

  function runBoot({ savedMode = null, savedPalette = null, prefersDark = false }) {
    const classes = new Set();
    const attrs = new Map();
    const sandbox = {
      localStorage: {
        getItem: (k) => (k === 'brosr-theme' ? savedMode : k === 'brosr-palette' ? savedPalette : null),
      },
      window: {
        matchMedia: () => ({ matches: prefersDark }),
      },
      document: {
        documentElement: {
          classList: {
            toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
            remove: (name) => classes.delete(name),
          },
          setAttribute: (k, v) => attrs.set(k, v),
        },
      },
    };
    vm.runInNewContext(bootCode, sandbox);
    return { dark: classes.has('dark'), palette: attrs.get('data-palette') ?? null };
  }

  for (const id of SEASONAL) {
    assert.deepEqual(runBoot({ savedMode: 'dark', savedPalette: id, prefersDark: false }), {
      dark: true,
      palette: id,
    });
    assert.deepEqual(runBoot({ savedMode: 'light', savedPalette: id, prefersDark: true }), {
      dark: false,
      palette: id,
    });
    assert.deepEqual(runBoot({ savedMode: 'system', savedPalette: id, prefersDark: true }), {
      dark: true,
      palette: id,
    });
  }

  // Unknown or classic palette values never leave an arbitrary attribute on <html>.
  assert.deepEqual(runBoot({ savedMode: 'light', savedPalette: 'classic', prefersDark: true }), {
    dark: false,
    palette: null,
  });
  assert.deepEqual(runBoot({ savedMode: null, savedPalette: 'unknown', prefersDark: true }), {
    dark: true,
    palette: null,
  });
});

test('app shell wires Settings button in top-right header with Appearance and Check for updates', () => {
  const appTsx = read('app/src/App.tsx');
  const settingsTsx = read('app/src/components/settings-dialog.tsx');
  const themeTs = read('app/src/lib/theme.ts');
  const updateTs = read('app/src/lib/update.ts');

  assert.match(appTsx, /aria-label="Settings"/);
  assert.match(appTsx, /<SettingsDialog[\s\S]*onMode=\{setMode\}[\s\S]*onPalette=\{setPalette\}/);

  assert.match(settingsTsx, /Appearance/);
  assert.match(settingsTsx, /Check for updates/);
  assert.match(settingsTsx, /findUpdate/);
  assert.match(updateTs, /export async function findUpdate/);

  for (const id of ['classic', ...SEASONAL]) {
    assert.match(themeTs, new RegExp(`id:\\s*'${id}'`), `PALETTES missing ${id}`);
  }
});
