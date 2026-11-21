import { useEffect, useState } from 'react';

// Light or dark is the resolved look. Mode is what the person chose, and
// System follows the operating system while the app is open.
export type Theme = 'light' | 'dark';
export type Mode = Theme | 'system';
export type Palette = 'classic' | 'halloween' | 'thanksgiving' | 'christmas';

// The boot script in index.html reads the same two keys before React loads, so
// the first paint already carries the saved look.
const MODE_KEY = 'brosr-theme';
const PALETTE_KEY = 'brosr-palette';

export type PaletteInfo = {
  id: Palette;
  name: string;
  blurb: string;
  // Three preview chips per look: background, card and the primary colour.
  swatch: Record<Theme, [string, string, string]>;
};

export const PALETTES: PaletteInfo[] = [
  {
    id: 'classic',
    name: 'Classic',
    blurb: 'Quiet silver',
    swatch: {
      light: ['#f6f6f6', '#fdfdfd', '#232323'],
      dark: ['#141414', '#222222', '#ececec'],
    },
  },
  {
    id: 'halloween',
    name: 'Halloween',
    blurb: 'Pumpkin and midnight purple',
    swatch: {
      light: ['#fbf3e6', '#fffaf2', '#d2541a'],
      dark: ['#1a1022', '#251a30', '#f08a2c'],
    },
  },
  {
    id: 'thanksgiving',
    name: 'Thanksgiving',
    blurb: 'Harvest gold and rust',
    swatch: {
      light: ['#faf4e8', '#fffbf3', '#a4442a'],
      dark: ['#1e1712', '#2a211a', '#e3a443'],
    },
  },
  {
    id: 'christmas',
    name: 'Christmas',
    blurb: 'Pine, cranberry and gold',
    swatch: {
      light: ['#f5faf6', '#fdfffd', '#b3262d'],
      dark: ['#0e1d16', '#172a21', '#d8323a'],
    },
  },
];

const PALETTE_IDS = new Set<string>(PALETTES.map((entry) => entry.id));

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A refused store keeps the look for this launch.
  }
}

function initialMode(): Mode {
  const saved = read(MODE_KEY);
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

function initialPalette(): Palette {
  const saved = read(PALETTE_KEY);
  return saved && PALETTE_IDS.has(saved) ? (saved as Palette) : 'classic';
}

function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function useTheme() {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [palette, setPalette] = useState<Palette>(initialPalette);
  const [system, setSystem] = useState<Theme>(systemTheme);

  // System mode follows a change in the OS setting while the window is open.
  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const change = () => setSystem(query.matches ? 'dark' : 'light');
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);

  const theme: Theme = mode === 'system' ? system : mode;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  useEffect(() => {
    write(MODE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    const root = document.documentElement;
    if (palette === 'classic') root.removeAttribute('data-palette');
    else root.setAttribute('data-palette', palette);
    write(PALETTE_KEY, palette);
  }, [palette]);

  return {
    theme,
    mode,
    palette,
    setMode,
    setPalette,
    toggle: () => setMode(theme === 'dark' ? 'light' : 'dark'),
  };
}
