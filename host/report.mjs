// The sync report is one file that runs as a browser script and as a Node
// module. The app stages bridge/ and host/ under app/, and app/package.json
// marks every .js file as module type, so Node loads sync-report.js as ES
// there and module.exports never runs. The UMD still publishes the global, so
// this reads the CommonJS export first and the published global second.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const loaded = require('../bridge/panel/sync-report.js');
const exported = loaded && loaded.buildSyncReport;
const published = globalThis.brosrSyncReport && globalThis.brosrSyncReport.buildSyncReport;
const builder = typeof exported === 'function' ? exported : published;

if (typeof builder !== 'function') {
  throw new Error('the sync report did not load from bridge/panel/sync-report.js');
}

export const buildSyncReport = builder;
