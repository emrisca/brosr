'use strict';
// The host writes documents to the relay's docs folder. A guest never calls
// this: the room carries the library instead, so a peer on the LAN needs no
// token and no path to the host folder. The token rides in the page fragment
// and never in a room invite.
(function () {
  const params = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const token = hash.get('dt') || '';
  const host = params.get('role') === 'host';

  function href(pathname, query) {
    const target = new URL(pathname, location.origin);
    for (const key of Object.keys(query || {})) {
      if (query[key]) target.searchParams.set(key, query[key]);
    }
    if (token) target.searchParams.set('token', token);
    return target.toString();
  }

  async function call(method, pathname, query, body) {
    const res = await fetch(href(pathname, query), {
      method,
      cache: 'no-store',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error('docs ' + res.status);
    return res.json();
  }

  // A document id stays lowercase so the relay can use it as a file name.
  let counter = 0;
  function id() {
    counter += 1;
    const bytes = new Uint8Array(3);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    const tail = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return 'd-' + Date.now().toString(36) + '-' + tail + counter.toString(36);
  }

  window.BrosrDocs = {
    host,
    room: params.get('room') || 'default',
    token,
    id,
    async list(kind) {
      const body = await call('GET', '/docs', { kind: kind || '' });
      return Array.isArray(body.docs) ? body.docs : [];
    },
    async get(docId) {
      const body = await call('GET', '/docs/' + encodeURIComponent(docId));
      return body.doc || null;
    },
    async put(doc) {
      await call('PUT', '/docs/' + encodeURIComponent(doc.id), null, doc);
      return doc;
    },
    async remove(docId) {
      await call('DELETE', '/docs/' + encodeURIComponent(docId));
      return true;
    },
  };
})();
