/**
 * Test shim: load a real entry point and let the test ask for a graceful
 * shutdown. Windows cannot deliver POSIX signals to a child process, so on
 * those hosts the test sends `shutdown` and the shim emits the same SIGTERM
 * event the entry point listens for. POSIX runs keep using a real signal.
 */

import { pathToFileURL } from 'node:url';

const entry = process.argv[2];

if (entry) {
  process.on('message', (message) => {
    if (message === 'shutdown') process.emit('SIGTERM');
  });
  await import(pathToFileURL(entry).href);
}
