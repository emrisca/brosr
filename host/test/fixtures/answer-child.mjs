// A child at the process boundary. It holds the event loop open the way a fetch
// connection pool does, then answers. If the exit waits for the loop to drain
// instead of running inside the write callback, this child never ends.
import net from 'node:net';
import { answer } from '../../cli.mjs';

const held = net.createServer();
held.listen(0, '127.0.0.1', () => {
  answer({ ok: true, marker: 'answer-child', rooms: [] });
});
setInterval(() => {}, 1000);
