#!/usr/bin/env node
// Run on the app host as the service user: node scripts/cslink-control.mjs status|reload|drain|resume|check-restart
import net from 'node:net';
const command = process.argv[2] || 'status';
if (!['status', 'reload', 'drain', 'resume', 'check-restart'].includes(command)) throw new Error('Unknown command');
const socketPath = process.env.CSLINK_CONTROL_SOCKET || '/srv/cslink/state/control.sock';
const socket = net.connect(socketPath);
socket.setTimeout(30_000, () => { console.error('Control request timed out'); socket.destroy(); process.exitCode = 1; });
socket.on('connect', () => socket.write(command + '\n'));
let data = '';
socket.on('data', chunk => { data += chunk; });
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
socket.on('end', () => {
  try {
    const reply = JSON.parse(data);
    console.log(JSON.stringify(reply, null, 2));
    if (!reply.ok || (command === 'check-restart' && !reply.result.safeToRestart)) process.exitCode = 1;
  } catch { console.error('Invalid control response'); process.exitCode = 1; }
});
