/**
 * Tests for the external-MongoDB connector's safety bounds (roadmap 1.7,
 * findings con.03 / sec.03 / con.12): egress policy at validation time,
 * bounded connection against a non-responding server, generic errors.
 *
 * No external network: the "server" is a local TCP listener on 127.0.0.1
 * that accepts connections and never answers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import env from '../../../../src/config/env.js';
import { MongoDBConnector, buildClientOptions } from '../../../../src/modules/connectors/mongodb/mongodb.connector.js';
import { validateConfig } from '../../../../src/modules/connectors/shared/validators.js';

const base = { database: 'app', collection: 'orders' };

async function withEnv(patch, fn) {
  const saved = {};
  for (const [path, value] of Object.entries(patch)) {
    const [group, key] = path.split('.');
    saved[path] = env.connectors[group][key];
    env.connectors[group][key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [path, value] of Object.entries(saved)) {
      const [group, key] = path.split('.');
      env.connectors[group][key] = value;
    }
  }
}

test('validateConfig refuses internal, metadata and platform targets when private networks are not allowed', () => {
  const previous = env.connectors.allowPrivateNetworks;
  env.connectors.allowPrivateNetworks = false;
  try {
    const refused = [
      'mongodb://127.0.0.1:27017/x',
      'mongodb://10.0.0.5:27017/x',
      'mongodb://169.254.169.254/x',
      'mongodb://mongo:27017/saas_analytics',
      'mongodb://localhost/x',
      'mongodb://[::1]:27017/x',
      'mongodb://db.internal/x',
      'mongodb://u:pw@db.example.com,10.1.1.1:27018/x',
    ];
    for (const uri of refused) {
      const verdict = validateConfig('mongodb', { ...base, uri });
      assert.equal(verdict.valid, false, uri);
      const message = verdict.errors.map((e) => e.message).join(' ');
      for (const leak of ['127.0.0.1', '10.0.0.5', '169.254', 'mongo:', 'pw', '10.1.1.1']) {
        assert.equal(message.includes(leak), false, `${uri}: message echoes ${leak}`);
      }
    }
    assert.equal(validateConfig('mongodb', { ...base, uri: 'mongodb+srv://u:p@cluster0.abcd.mongodb.net/x?retryWrites=true&w=majority' }).valid, true);
  } finally {
    env.connectors.allowPrivateNetworks = previous;
  }
});

test('validateConfig refuses the platform database even when private networks are allowed', () => {
  const previous = env.connectors.allowPrivateNetworks;
  env.connectors.allowPrivateNetworks = true;
  try {
    // env.database.uri defaults to mongodb://127.0.0.1:27017/... in tests.
    const verdict = validateConfig('mongodb', { ...base, uri: 'mongodb://localhost:27017/saas_analytics' });
    assert.equal(verdict.valid, false);
    assert.equal(validateConfig('mongodb', { ...base, uri: 'mongodb://127.0.0.1:27999/x' }).valid, true, 'another local port is fine in a private deployment');
  } finally {
    env.connectors.allowPrivateNetworks = previous;
  }
});

test('validateConfig refuses non-allow-listed URI options (proxyHost, MONGODB-AWS, TLS bypass)', () => {
  for (const option of ['proxyHost=evil.example.com', 'authMechanism=MONGODB-AWS', 'tlsAllowInvalidCertificates=true', 'loadBalanced=true']) {
    const verdict = validateConfig('mongodb', { ...base, uri: `mongodb://u:secret@db.example.com/app?${option}` });
    assert.equal(verdict.valid, false, option);
    assert.equal(JSON.stringify(verdict.errors).includes('secret'), false);
  }
});

test('client options are bounded and cannot be widened by the connection string', () => {
  const options = buildClientOptions();
  assert.equal(options.maxPoolSize, 1);
  assert.equal(options.socketTimeoutMS, env.connectors.mongodbLimits.socketTimeoutMs);
  assert.equal(options.connectTimeoutMS, env.connectors.mongodb.connectTimeoutMs);
  assert.equal(options.serverSelectionTimeoutMS, env.connectors.mongodb.serverSelectionTimeoutMs);
  assert.equal(typeof options.lookup, 'function');
});

test('a server that accepts connections but never answers fails within the configured timeout, with a generic error', async () => {
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); }); // never replies
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await withEnv({
      'mongodb.connectTimeoutMs': 300,
      'mongodb.serverSelectionTimeoutMs': 400,
      'mongodbLimits.socketTimeoutMs': 300,
    }, async () => {
      const previous = env.connectors.allowPrivateNetworks;
      env.connectors.allowPrivateNetworks = true; // a deliberately private deployment
      try {
        const connector = new MongoDBConnector({ config: { ...base, uri: `mongodb://admin:hunter2@127.0.0.1:${port}/app` } });
        const started = Date.now();
        await assert.rejects(async () => {
          for await (const doc of connector.ingest()) void doc;
        }, (err) => {
          assert.equal(err.code, 'CONNECTOR_SOURCE_UNAVAILABLE');
          assert.equal(err.statusCode, 502);
          for (const leak of ['127.0.0.1', String(port), 'hunter2', 'admin', 'Server selection']) {
            assert.equal(err.message.includes(leak), false, `leaks ${leak}: ${err.message}`);
          }
          return true;
        });
        assert.ok(Date.now() - started < 5000, `failed after ${Date.now() - started} ms`);
      } finally {
        env.connectors.allowPrivateNetworks = previous;
      }
    });
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
