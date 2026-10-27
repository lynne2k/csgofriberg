import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** Local Unix socket only. Never expose maintenance through the public HTTP proxy. */
export async function startCsLinkControl(socketPath: string,
  execute: (command: string) => unknown | Promise<unknown>): Promise<() => Promise<void>> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(socketPath)) {
    if (!fs.lstatSync(socketPath).isSocket()) throw new Error('CSLINK_CONTROL_PATH_NOT_SOCKET');
    // Refuse to replace another live process's control channel.
    const live = await new Promise<boolean>((resolve, reject) => {
      const probe = net.connect(socketPath);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', error => {
        if (['ECONNREFUSED', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) resolve(false);
        else reject(error);
      });
    });
    if (live) throw new Error('CSLINK_CONTROL_ALREADY_RUNNING');
    fs.rmSync(socketPath, { force: true });
  }
  const server = net.createServer(socket => {
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    let input = '', handled = false;
    socket.on('data', async chunk => {
      if (handled) return;
      input += chunk.toString();
      if (input.length > 128) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      handled = true;
      try { socket.end(JSON.stringify({ ok: true, result: await execute(input.trim()) }) + '\n'); }
      catch (error) { socket.end(JSON.stringify({ ok: false, error: (error as Error).message }) + '\n'); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); resolve(); });
  });
  return () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
