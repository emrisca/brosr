// Renders assets/brosr-icon.svg to the 1024 pixel master with headless Chrome.
// The SVG stays the source, so the master is one command away after an edit.
// Run `node assets/render-icon.mjs`, then `node assets/icons.mjs` for the copies.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, 'brosr-icon.svg');
const TARGET = path.join(here, 'brosr-icon.png');
const PAGE = path.join(here, '.icon-render.html');
const CHROME =
  process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!fs.existsSync(CHROME)) {
  console.error('[icon] Chrome is missing. Set CHROME to the binary.');
  process.exit(1);
}

// The SVG loads inline, because Chrome refuses a file subresource from a file
// page. The page is exactly the icon size, so the shot needs no crop.
const svg = fs.readFileSync(SOURCE, 'utf8');
fs.writeFileSync(
  PAGE,
  `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block;width:1024px;height:1024px}</style>${svg}`
);

execFileSync(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--default-background-color=00000000',
    '--force-device-scale-factor=1',
    '--window-size=1024,1024',
    `--screenshot=${TARGET}`,
    `file://${PAGE}`,
  ],
  { stdio: 'inherit' }
);

fs.rmSync(PAGE, { force: true });
console.log(`[icon] ${path.basename(TARGET)} ${fs.statSync(TARGET).size} bytes`);
