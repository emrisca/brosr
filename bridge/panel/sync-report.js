// Builds the text a person copies when syncing looks wrong. The panel already
// has the room status and the film tab reading, so the report is one pass over
// those two objects and never reads the page or the network.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.brosrSyncReport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Invite fragments and token parameters are not part of a sync bug. A film
  // key keeps its useful query, such as YouTube's v= id, and drops the rest.
  const SECRET_PARAM =
    /^(?:k|key|token|secret|password|pass|auth|code|session|sig|signature|access_token|refresh_token)$/i;

  function present(value) {
    return value !== undefined && value !== null && value !== '';
  }

  function cleanUrl(value, keepQuery) {
    if (!present(value)) return '';
    const text = String(value);
    if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) return text.replace(/#.*$/, '');
    try {
      const url = new URL(text);
      if (keepQuery) {
        for (const key of [...url.searchParams.keys()]) {
          if (SECRET_PARAM.test(key)) url.searchParams.delete(key);
        }
      } else {
        url.search = '';
      }
      url.hash = '';
      return url.toString();
    } catch {
      return text.replace(/#.*$/, '');
    }
  }

  function filmLabel(key) {
    const text = String(key || '').trim();
    if (!text) return 'The film';
    if (text.startsWith('youtube:')) return 'YouTube film';
    try {
      return new URL(text).hostname.replace(/^www\./, '') || 'The film';
    } catch {
      return text;
    }
  }

  function clock(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return '-';
    const total = Math.round(value * 10);
    const whole = Math.floor(total / 10);
    const tenths = total % 10;
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const rest = whole % 60;
    const pad = (part) => String(part).padStart(2, '0');
    const tail = `${pad(rest)}.${tenths}`;
    return hours ? `${hours}:${pad(minutes)}:${tail}` : `${minutes}:${tail}`;
  }

  function gap(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    if (Math.abs(number) < 0.005) return 'level with the room';
    return `${Math.abs(number).toFixed(2)} s ${
      number > 0 ? 'behind' : 'ahead of'
    } the room`;
  }

  function offset(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number === 0) return '';
    const abs = Math.abs(number);
    const text = abs < 1000 ? `${Math.round(abs)} ms` : `${(abs / 1000).toFixed(2)} s`;
    return `${number > 0 ? '+' : '-'}${text}`;
  }

  function stamp(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '';
    try {
      return new Date(number).toISOString();
    } catch {
      return '';
    }
  }

  function ago(value, now) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return '';
    return `${Math.max(0, Math.round((now - number) / 1000))}s ago`;
  }

  function json(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }

  function shortStamp(value) {
    const at = stamp(value);
    return at ? `${at.slice(11, 23)}Z` : '';
  }

  function durationText(value) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms < 0) return '';
    return `${(ms / 1000).toFixed(1)} s`;
  }

  function buildSyncReport(reply, reading, context = {}) {
    const data = reply && reply.data ? reply.data : null;
    const now = Number(context.now) || Date.now();
    const lines = ['Brosr sync report', `Generated: ${new Date(now).toISOString()}`];
    if (!data) {
      lines.push('Status: no room reply.');
      return lines.join('\n');
    }

    const add = (label, value) => {
      if (present(value)) lines.push(`${label}: ${value}`);
    };
    const listedPeers = Array.isArray(data.peerList) ? data.peerList.filter(Boolean) : [];
    // A host's roster may only name the other people in the room. The copied
    // report is read on its own, so it adds the person who copied it back.
    const self =
      data.peerId && !listedPeers.some((peer) => peer.self)
        ? {
            id: data.peerId,
            name: data.name || data.peerId,
            self: true,
            granted: Boolean(data.granted),
            build: data.build || null,
          }
        : null;
    const peers = self ? [self, ...listedPeers] : listedPeers;
    const peerCount = Number.isFinite(data.peers)
      ? Math.max(data.peers, peers.length)
      : peers.length;
    const nameFor = (id) => {
      const peer = peers.find((item) => String(item.id) === String(id));
      return peer
        ? `${peer.name || peer.id}${peer.self ? ' (you)' : ''}`
        : String(id || 'unknown');
    };
    const media = data.media || null;
    const ownBuild = data.build && (data.build.version || data.build);
    const hostBuild = data.hostBuild && (data.hostBuild.version || data.hostBuild);
    const stale = peers.filter(
      (peer) =>
        peer.build &&
        peer.build.version &&
        ownBuild &&
        peer.build.version !== ownBuild
    );

    add('Local time', new Date(now).toString());
    add('Panel', context.surface);
    add('Browser', context.userAgent);
    add('Route', context.route);
    add('Room', data.roomName || (reply && reply.room) || 'unknown');
    add('Role', data.role || (reply && reply.role));
    add('Peer id', data.peerId);
    add('Bridge', ownBuild);
    add('Host bridge', hostBuild);
    add('Connected', data.socket === 1 ? 'yes' : 'no');
    add(
      'Relay',
      data.socket === 1
        ? data.reconnects
          ? `live, ${data.reconnects} reconnects`
          : 'live'
        : 'reconnecting'
    );
    add('Playback', data.playing === true ? 'playing' : data.playing === false ? 'paused' : '');
    add('Peers', peerCount);
    add('Page', cleanUrl(data.location || data.url, false));

    if (stale.length) {
      const names = stale.map((peer) => `${peer.name || peer.id} runs ${peer.build.version}`);
      add('Build warning', `${names.join(', ')}; this room runs ${ownBuild}.`);
    }
    if (data.seal && data.seal.mode) {
      add('Seal', data.seal.error ? `${data.seal.mode} (${data.seal.error})` : data.seal.mode);
    }
    add('Same fate', data.sameFate === true ? 'on' : data.sameFate === false ? 'off' : '');
    if (data.latency && Number.isFinite(Number(data.latency.p95))) {
      add(
        'Latency',
        `${Math.round(Number(data.latency.p95))} ms p95` +
          (Number.isFinite(Number(data.latency.p50))
            ? `, ${Math.round(Number(data.latency.p50))} ms p50`
            : '')
      );
    }
    add('Clock offset', present(data.clockOffset) ? `${data.clockOffset} ms` : '');
    add('Drift rate', present(data.driftRate) ? data.driftRate : '');
    add('Samples', present(data.sampleCount) ? data.sampleCount : '');

    if (peers.length) {
      lines.push('Peer list:');
      for (const peer of peers) {
        const flags = [];
        if (peer.self) flags.push('you');
        if (peer.granted) flags.push('control');
        const build = peer.build && peer.build.version ? ` bridge ${peer.build.version}` : '';
        lines.push(
          `- ${peer.name || peer.id || 'peer'} (${peer.id || 'no id'})${build}${
            flags.length ? ` [${flags.join(', ')}]` : ''
          }`
        );
      }
    }

    if (media) {
      add('Film', filmLabel(media.key));
      add('Film key', cleanUrl(media.key, true));
      add('Film title', media.title);
      add('Room position', clock(media.position));
      add(
        'Local position',
        media.open ? clock(media.localPosition) : 'no tab on the film'
      );
      const flags = [media.playing ? 'playing' : 'paused'];
      if (media.buffering) flags.push('buffering');
      if (media.ad) flags.push('ad');
      flags.push(media.open ? 'open here' : 'no tab here');
      add('Media state', flags.join(', '));
      add('Local gap', gap(media.behind));
      add(
        'In sync',
        media.inSync === true ? 'yes' : media.inSync === false ? 'no' : 'not measured'
      );
    } else {
      add('Film', 'none');
    }

    const relay = reading && reading.relay;
    if (relay) {
      const parts = [];
      // `applies` counts every frame the film tab handled. The applied, skipped
      // and held counts live in stats, and naming only the first number hid
      // most of a session that spent its time skipping.
      if (Number.isFinite(Number(relay.applies))) parts.push(`${Number(relay.applies)} frames`);
      const filmStats = relay.stats || null;
      if (filmStats) {
        const applied = Number(filmStats.applied);
        const skipped = Number(filmStats.skips) || 0;
        const holds = Number(filmStats.holds) || 0;
        if (Number.isFinite(applied)) parts.push(`${applied} applied`);
        if (skipped) parts.push(`${skipped} skipped`);
        if (holds) parts.push(`${holds} hold${holds === 1 ? '' : 's'}`);
      }
      if (relay.last && Number.isFinite(Number(relay.last.drift))) {
        parts.push(`${Math.abs(Number(relay.last.drift)).toFixed(2)} s on the last frame`);
      }
      if (media && Number.isFinite(Number(media.behind))) {
        parts.push(`${Math.abs(Number(media.behind)).toFixed(2)} s from the room`);
      }
      if (filmStats) {
        const waits = Number(filmStats.bufferWaits) || 0;
        const stuck = Number(filmStats.stuckSeeks) || 0;
        if (waits) parts.push(`${waits} buffer wait${waits === 1 ? '' : 's'}`);
        if (stuck) parts.push(`${stuck} stuck seek${stuck === 1 ? '' : 's'}`);
      }
      add('Reading', parts.join(' · '));
    } else {
      const reply = context.readingReply;
      const failed = reply && Array.isArray(reply.failed) ? reply.failed[0] : null;
      const reason = reply
        ? [reply.reason, failed && (failed.answer || failed.error)]
            .filter(Boolean)
            .join(', ') || (reply.ok ? 'no-relay' : 'unknown')
        : 'no-response';
      add('Reading', `unavailable (${reason})`);
    }

    add('Matched copy', offset(data.align && data.align.offsetMs));

    const holds = Array.isArray(data.holds) ? data.holds.filter(Boolean) : [];
    if (holds.length) {
      add(
        'Holds',
        holds
          .map((hold) => {
            const age = Number(hold.ageMs);
            const since = Number.isFinite(age) && age >= 0 ? ` for ${(age / 1000).toFixed(1)} s` : '';
            return `${nameFor(hold.peerId)}${since} at ${clock(hold.position)}, ${
              hold.playing ? 'playing' : 'paused'
            }`;
          })
          .join('; ')
      );
    }
    if (data.lastHoldEvent) {
      const last = data.lastHoldEvent;
      const at = stamp(last.eventAt);
      add(
        'Last hold',
        `${last.active ? 'started' : 'released'} by ${nameFor(last.peerId)}` +
          (at ? ` at ${at}` : '') +
          ` (${clock(last.position)}, ${last.playing ? 'playing' : 'paused'})`
      );
    }
    if (data.hostPriority && present(data.hostPriority.lastActAt)) {
      const at = stamp(data.hostPriority.lastActAt);
      const remaining = Math.max(0, Math.round(Number(data.hostPriority.remainingMs) || 0));
      add(
        'Host priority',
        `${remaining > 0 ? `${remaining} ms left` : 'clear'}${
          at ? `, last host act at ${at}` : ''
        }`
      );
    }
    if (data.lastMediaFrame) {
      const last = data.lastMediaFrame;
      const age = Number(last.ageMs);
      add(
        'Last media frame',
        `${clock(last.position)}, ${last.playing ? 'playing' : 'paused'}` +
          (Number.isFinite(age) ? `, ${(age / 1000).toFixed(2)} s ago` : '')
      );
    }
    if (data.lastSeek) {
      const last = data.lastSeek;
      let text = present(last.target) ? clock(last.target) : '';
      const at = stamp(last.at);
      if (at) text += `${text ? ' ' : ''}at ${at}`;
      const waiting = stamp(last.waitingSince);
      if (waiting) text += `${text ? ', ' : ''}waiting since ${waiting}`;
      if (text) add('Last seek', text);
    }

    const relayHistory = relay && relay.history;
    if (relayHistory) {
      const recent = (list) => (Array.isArray(list) ? list.slice(-5) : []);
      const seeks = recent(relayHistory.seeks);
      if (seeks.length) {
        add(
          'Relay seeks',
          seeks
            .map((event) => {
              const at = shortStamp(event.at);
              return `${clock(event.target)}${event.kind ? ` (${event.kind})` : ''}${
                at ? ` at ${at}` : ''
              }`;
            })
            .join('; ')
        );
      }
      const buffers = recent(relayHistory.buffers);
      if (buffers.length) {
        add(
          'Relay buffer waits',
          buffers
            .map((event) => {
              const spent = durationText(event.durationMs);
              const at = shortStamp(event.at);
              return `${clock(event.target)} ${event.outcome || 'waiting'}${
                spent ? ` after ${spent}` : ''
              }${at ? ` at ${at}` : ''}`;
            })
            .join('; ')
        );
      }
      const relayHolds = recent(relayHistory.holds);
      if (relayHolds.length) {
        add(
          'Relay holds',
          relayHolds
            .map((event) => {
              const spent = durationText(event.durationMs);
              const at = shortStamp(event.at);
              return `${clock(event.position)}, ${
                event.playing ? 'playing' : 'paused'
              }, ${event.outcome || 'active'}${spent ? ` after ${spent}` : ''}${
                at ? ` at ${at}` : ''
              }`;
            })
            .join('; ')
        );
      }
    }

    if (data.lastMediaAction) {
      const last = data.lastMediaAction;
      const at = stamp(last.at);
      add(
        'Last media action',
        [last.text || last.action || 'unknown', at ? `at ${at}` : ''].filter(Boolean).join(' ')
      );
    }

    if (data.lastLocalMediaAction) {
      const last = data.lastLocalMediaAction;
      const at = stamp(last.at);
      let text = last.text;
      if (!text) {
        if (last.action === 'seek') text = `You jumped to ${clock(last.position)}`;
        else if (last.action === 'play') text = 'You played the video';
        else if (last.action === 'pause') text = 'You paused the video';
        else if (last.action === 'rate') text = `You set the speed to ${Number(last.rate || 1)}x`;
        else text = `You changed the film at ${clock(last.position)}`;
      }
      add('Last local media action', [text, at ? `at ${at}` : ''].filter(Boolean).join(' '));
    }

    const roomDrops =
      data.mediaDrops && typeof data.mediaDrops === 'object' ? data.mediaDrops : {};
    const localDrops =
      relay && relay.localDrops && typeof relay.localDrops === 'object'
        ? relay.localDrops
        : {};
    const dropParts = Object.entries(roomDrops)
      .filter(([, count]) => Number(count) > 0)
      .map(([reason, count]) => `${reason}=${Number(count)}`);
    if (dropParts.length) add('Dropped media acts', dropParts.join(', '));

    // A film tab sees the player answer a correction the room just made. That
    // answer is an echo, not a person's command. Counting it as a dropped act
    // made a healthy echo guard look like it had swallowed 53 seeks.
    const localEchoes = Number(localDrops.echo) || 0;
    if (localEchoes) {
      const lastEcho = relay && relay.lastLocalDrop ? relay.lastLocalDrop : null;
      const at = lastEcho ? stamp(lastEcho.at) : '';
      add(
        'Suppressed film-tab echoes',
        `${localEchoes}${lastEcho && lastEcho.action ? `, last ${lastEcho.action}` : ''}${
          at ? ` at ${at}` : ''
        }`
      );
    }

    const tickDrops =
      data.mediaDropTicks && typeof data.mediaDropTicks === 'object'
        ? data.mediaDropTicks
        : {};
    const tickParts = Object.entries(tickDrops)
      .filter(([, count]) => Number(count) > 0)
      .map(([reason, count]) => `${reason}=${Number(count)}`);
    if (tickParts.length) add('Dropped media ticks', tickParts.join(', '));

    // A suppressed echo is not a dropped command, so the last drop names only
    // the room path. The echo count above keeps the film-tab detail visible.
    const lastDrop = data.lastMediaDrop ? { ...data.lastMediaDrop, source: 'room' } : null;
    if (lastDrop) {
      const at = stamp(lastDrop.at);
      const peer = lastDrop.peerId ? `, ${lastDrop.peerId}` : '';
      add(
        'Last media drop',
        `${lastDrop.action || 'act'} from ${lastDrop.source} (${
          lastDrop.reason || 'unknown'
        }${peer})` +
          (at ? ` at ${at}` : '') +
          (present(lastDrop.position) ? ` (target ${clock(lastDrop.position)})` : '')
      );
      const hostAct = lastDrop.hostAct;
      if (hostAct) {
        const actAt = stamp(hostAct.at);
        const target = present(hostAct.position) ? `, target ${clock(hostAct.position)}` : '';
        add(
          'Host act behind drop',
          `${hostAct.action || 'act'}${target}${actAt ? `, at ${actAt}` : ''}`
        );
      }
    }

    const dropHistory = Array.isArray(data.mediaDropHistory)
      ? data.mediaDropHistory.filter((entry) => entry && entry.reason === 'host-priority')
      : [];
    if (dropHistory.length > 1) {
      add(
        'Host-priority drops',
        dropHistory
          .slice(-4)
          .map((entry) => {
            const at = stamp(entry.at);
            const target = present(entry.position) ? ` target ${clock(entry.position)}` : '';
            const act = entry.hostAct;
            const hostAt = act ? shortStamp(act.at) : '';
            const host = act
              ? `, host ${act.action || 'act'}${
                  present(act.position) ? ` ${clock(act.position)}` : ''
                }${hostAt ? ` at ${hostAt}` : ''}`
              : '';
            return `${entry.action || 'act'}${target}${at ? ` at ${at}` : ''}${host}`;
          })
          .join('; ')
      );
    }

    const control = [];
    if (present(data.controlSent)) control.push(`sent ${data.controlSent}`);
    if (present(data.controlReceived)) control.push(`received ${data.controlReceived}`);
    add('Control', control.join(', '));
    if (data.lastControl) {
      const last = data.lastControl;
      add(
        'Last control',
        `${last.allowed ? 'granted' : 'revoked'} ${last.peerId || 'a peer'}${
          last.mine ? ' (this peer)' : ''
        }`
      );
    }
    if (Array.isArray(data.controlHistory) && data.controlHistory.length) {
      add(
        'Control history',
        data.controlHistory
          .slice(-5)
          .map(
            (entry) =>
              `${entry.allowed ? 'granted' : 'revoked'} ${entry.peerId || 'a peer'}` +
              (present(entry.roomTime) ? ` at room ${entry.roomTime}` : '')
          )
          .join('; ')
      );
    }

    const counters = [
      ['seeks', data.seeks],
      ['nudges', data.nudges],
      ['corrections', data.corrections],
      ['stuck seeks', data.stuckSeeks],
      ['relayed', data.relayed],
      ['media echo', data.mediaEcho],
      ['media echo local', data.mediaEchoLocal],
      ['first drift', data.firstDrift],
      ['converged', data.convergedAt],
    ]
      .filter(([, value]) => present(value))
      .map(([name, value]) => `${name}=${value}`);
    if (counters.length) add('Media counters', counters.join(', '));

    if (data.stutter && (data.stutter.active || data.stutter.holds)) {
      add('Stutter', json(data.stutter));
    }
    add('Last command', data.command);
    add('Media debug', json(data.debug));

    if (Array.isArray(data.viewers) && data.viewers.length) {
      lines.push('Viewers:');
      for (const entry of data.viewers) {
        if (!entry) continue;
        const viewer = entry.viewer;
        const at = ago(entry.at, now);
        if (!viewer) {
          lines.push(`- ${nameFor(entry.id)}: no report${at ? ` (${at})` : ''}`);
          continue;
        }
        const parts = [
          viewer.open ? 'open' : 'no tab',
          viewer.playing ? 'playing' : 'paused',
        ];
        if (viewer.buffering) parts.push('buffering');
        if (viewer.ad) parts.push('ad');
        const seen = gap(viewer.behind);
        if (seen) parts.push(seen);
        if (viewer.inSync === true) parts.push('in sync');
        else if (viewer.inSync === false) parts.push('out of sync');
        lines.push(`- ${nameFor(entry.id)}: ${parts.join(', ')}${at ? ` (${at})` : ''}`);
      }
    }

    add(
      'Raw',
      json({
        build: data.build || null,
        hostBuild: data.hostBuild || null,
        peerList: peers.map((peer) => ({
          id: peer.id,
          name: peer.name,
          self: Boolean(peer.self),
          granted: Boolean(peer.granted),
          build: peer.build || null,
        })),
        media: media
          ? {
              key: cleanUrl(media.key, true),
              title: media.title || '',
              position: media.position,
              localPosition: media.localPosition,
              playing: Boolean(media.playing),
              buffering: Boolean(media.buffering),
              ad: Boolean(media.ad),
              open: Boolean(media.open),
              behind: media.behind,
              inSync: media.inSync,
            }
          : null,
        reading: relay
          ? {
              applies: relay.applies,
              last: relay.last || null,
              stats: relay.stats || null,
              localDrops: relay.localDrops || null,
              lastLocalDrop: relay.lastLocalDrop || null,
              history: relay.history || null,
            }
          : null,
        lastMediaAction: data.lastMediaAction || null,
        lastLocalMediaAction: data.lastLocalMediaAction || null,
        mediaDrops: data.mediaDrops || null,
        mediaDropTicks: data.mediaDropTicks || null,
        lastMediaDrop: data.lastMediaDrop || null,
        mediaDropHistory: data.mediaDropHistory || null,
        holds: holds.length ? holds : null,
        lastHoldEvent: data.lastHoldEvent || null,
        hostPriority: data.hostPriority || null,
        lastMediaFrame: data.lastMediaFrame || null,
        lastSeek: data.lastSeek || null,
        counters: {
          seeks: data.seeks,
          nudges: data.nudges,
          corrections: data.corrections,
          stuckSeeks: data.stuckSeeks,
          relayed: data.relayed,
          mediaEcho: data.mediaEcho,
          firstDrift: data.firstDrift,
          convergedAt: data.convergedAt,
        },
        latency: data.latency || null,
        clockOffset: data.clockOffset ?? null,
        driftRate: data.driftRate ?? null,
        sampleCount: data.sampleCount ?? null,
        debug: data.debug || null,
      })
    );

    return lines.join('\n');
  }

  return { buildSyncReport };
});
