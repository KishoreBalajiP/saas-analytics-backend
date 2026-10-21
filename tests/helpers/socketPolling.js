/**
 * Minimal Socket.IO client for tests, speaking the Engine.IO v4
 * long-polling protocol over HTTP (no socket.io-client is installed, and
 * polling is the transport every client falls back to):
 *
 *   GET  /socket.io/?EIO=4&transport=polling           -> open packet `0{sid}`
 *   POST ...&sid=<sid>  body `40{auth}`                 -> namespace CONNECT
 *   GET  ...&sid=<sid>                                  -> `40{...}` connected
 *                                                          or `44{...}` refused
 *   POST `42<id>["event",payload]` / GET `43<id>[ack]`  -> event with ack
 *
 * Several packets in one poll are separated by the 0x1e record separator.
 */

import assert from 'node:assert/strict';

const SEP = '\x1e';

/**
 * @param {string} base - `http://host:port/socket.io/?EIO=4&transport=polling`
 */
export function createPollingClient(base) {
  async function poll(sid) {
    const res = await fetch(`${base}&sid=${sid}`);
    const text = await res.text();
    return text.split(SEP).filter(Boolean);
  }

  async function send(sid, packet) {
    const res = await fetch(`${base}&sid=${sid}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: packet,
    });
    assert.equal(res.status, 200);
  }

  /**
   * Open a socket and connect to the default namespace with `auth`.
   * @returns {Promise<{ sid: string, connected: boolean, packet: string }>}
   */
  async function connect(auth = {}, headers = {}) {
    const open = await fetch(base, { headers });
    const text = await open.text();
    assert.equal(text[0], '0', `expected an open packet, got ${text}`);
    const { sid } = JSON.parse(text.slice(1));
    await send(sid, `40${JSON.stringify(auth)}`);
    const [packet] = await poll(sid);
    return { sid, connected: packet.startsWith('40'), packet };
  }

  /** The `data` of a refused CONNECT (`44{...}`). */
  function connectError(packet) {
    assert.ok(packet.startsWith('44'), `connect_error expected, got ${packet}`);
    return JSON.parse(packet.slice(2));
  }

  let ackId = 0;
  /** Emit an event with an ack and return the ack payload. */
  async function emitWithAck(sid, event, payload) {
    ackId += 1;
    const id = ackId;
    await send(sid, `42${id}${JSON.stringify([event, payload])}`);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const packets = await poll(sid);
      const ack = packets.find((p) => p.startsWith(`43${id}[`));
      if (ack) return JSON.parse(ack.slice(`43${id}`.length))[0];
    }
    throw new Error(`no ack for ${event}`);
  }

  /** Close the Engine.IO session (packet `1`). */
  async function close(sid) {
    await send(sid, '1');
  }

  return { poll, send, connect, connectError, emitWithAck, close };
}

export default { createPollingClient };
