// Proves that a profile blocks the hosts in the FMHY list. The probe page asks
// for a URL at each host and for a control URL on loopback. A blocked request
// rejects with a network error, and the control resolves. The bare profile must
// show the probes resolving, so the list is the only difference.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LISTS, PROBES, RUNTIME, fetchListText, runProbes, withBrowser } from './safe-browsing.mjs';

export async function proveBlocking(profile, options = {}) {
  const text = await fetchListText(LISTS[0], RUNTIME, { refresh: Boolean(options.refresh) });
  const absent = PROBES.filter((host) => !text.includes(`||${host}^`));
  if (absent.length) throw new Error(`the list does not name ${absent.join(', ')}`);
  return await withBrowser(profile, options, async (bidi) => {
    const context = (await bidi.cmd('browsingContext.getTree', {})).contexts[0].context;
    const settle = Number(options.settle || 12000);
    await new Promise((resolve) => setTimeout(resolve, settle));
    const probe = await runProbes(bidi, context);
    return {
      when: new Date().toISOString(),
      profile,
      rows: probe.rows,
      blocked: probe.blocked,
      want: probe.want,
      control: probe.control,
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : fallback;
  };
  const profile = arg('profile', '');
  const bare = arg('compare', '');
  if (!profile) {
    console.log('[prove] pass --profile=<dir> and, to show the difference, --compare=<bare dir>');
    process.exit(1);
  }
  const one = await proveBlocking(path.resolve(profile), { port: Number(arg('port', '9361')) });
  const say = (label, res) => {
    console.log(`[prove] ${label} blocked ${res.blocked} of ${res.want}, control ${res.control.state}`);
    for (const row of res.rows) {
      console.log(`[prove] ${label} ${row.blocked ? 'blocked ' : 'resolved'} ${row.url} (${row.detail})`);
    }
  };
  say('list', one);
  let two = null;
  if (bare) {
    two = await proveBlocking(path.resolve(bare), { port: Number(arg('port', '9361')) + 1 });
    say('bare', two);
  }
  const held = one.control.state === 'resolved' && one.blocked === one.want;
  if (!held) {
    console.log(`[prove] the list holds ${one.blocked} of ${one.want} probes, so the proof fails`);
    process.exit(1);
  }
  if (two) {
    console.log(`[prove] the bare profile blocks ${two.blocked} of ${two.want}, so the list adds the rest`);
  }
  console.log(`[prove] proof holds: ${one.blocked} of ${one.want} blocked, control loaded`);
}
