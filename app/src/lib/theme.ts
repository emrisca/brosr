import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const KEY = 'brosr-theme';

function initial(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initial);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // A refused store keeps the class for this launch.
    }
  }, [theme]);

  return {
    theme,
    toggle: () => setTheme((value) => (value === 'dark' ? 'light' : 'dark')),
  };
}
