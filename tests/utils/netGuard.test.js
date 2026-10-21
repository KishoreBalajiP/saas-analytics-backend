/**
 * Unit tests for `utils/netGuard.js` - the egress policy for network
 * connectors (roadmap 1.7). DNS is never queried: every resolution goes
 * through an injected fake resolver.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isNonPublicAddress,
  isObviouslyInternalHost,
  parseMongoUri,
  disallowedMongoOptions,
  platformHostPolicy,
  isPlatformHost,
  isHostAllowListed,
  assertEgressAllowed,
  assertPublicMongoHosts,
  createGuardedLookup,
} from '../../src/utils/netGuard.js';
import { validateConfig } from '../../src/modules/connectors/shared/validators.js';

const NO_PLATFORM = { endpoints: [], suffixes: [] };

/** Fake resolver: host -> addresses; SRV name -> records. */
function resolver(map = {}, srv = {}) {
  const calls = [];
  return {
    calls,
    lookup: async (host) => {
      calls.push(host);
      if (!(host in map)) throw new Error(`ENOTFOUND ${host}`);
      return map[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    resolveSrv: async (name) => {
      calls.push(name);
      if (!(name in srv)) throw new Error(`ENOTFOUND ${name}`);
      return srv[name];
    },
  };
}

/** Assert an egress refusal never echoes the host, address or credentials. */
async function rejectsGenerically(promise, secrets, code) {
  await assert.rejects(promise, (err) => {
    if (code) assert.equal(err.code, code);
    for (const s of secrets) assert.equal(String(err.message).includes(s), false, `message leaks ${s}: ${err.message}`);
    return true;
  });
}

test('isNonPublicAddress classifies IPv4 and IPv6 forms, including embedded IPv4', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1']) {
    assert.equal(isNonPublicAddress(ip), true, ip);
  }
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::ffff:a9fe:a9fe', '64:ff9b::a00:1', '2002:a00:1::', '2001:db8::1', '2001:0:4136:e378::1']) {
    assert.equal(isNonPublicAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isNonPublicAddress(ip), false, ip);
  }
  assert.equal(isNonPublicAddress('not-an-ip'), true);
});

test('isObviouslyInternalHost refuses internal names and numeric / hex host spellings', () => {
  for (const host of ['localhost', 'mongo', 'db.local', 'metadata.google.internal', 'x.localhost', '127.1', '0x7f.0.0.1', '2130706433', '10.0.0.5']) {
    assert.equal(isObviouslyInternalHost(host), true, host);
  }
  for (const host of ['cluster0.abcd.mongodb.net', 'db.example.com', '8.8.8.8']) {
    assert.equal(isObviouslyInternalHost(host), false, host);
  }
});

test('URI options: only the explicit allow-list is accepted', () => {
  const ok = parseMongoUri('mongodb+srv://u:p@cluster0.abcd.mongodb.net/db?retryWrites=true&w=majority&authSource=admin&tls=true&appName=x');
  assert.deepEqual(disallowedMongoOptions(ok), []);

  const cases = {
    'mongodb://h.example.com/db?proxyHost=evil.example.com': 'proxyHost',
    'mongodb://h.example.com/db?authMechanism=MONGODB-AWS': 'authMechanism',
    'mongodb://h.example.com/db?tlsCAFile=/etc/passwd': 'tlsCAFile',
    'mongodb://h.example.com/db?tlsInsecure=true': 'tlsInsecure',
    'mongodb+srv://h.example.com/db?srvServiceName=internal': 'srvServiceName',
    'mongodb://h.example.com/db?someFutureOption=1': 'someFutureOption',
    'mongodb://h.example.com/db?socketTimeoutMS=0': 'socketTimeoutMS',
    'mongodb://h.example.com/db?tls=maybe': 'tls',
    'mongodb://h.example.com/db?appName=evil.internal%3A27017%20x%2Fy': 'appName',
  };
  for (const [uri, expected] of Object.entries(cases)) {
    assert.deepEqual(disallowedMongoOptions(parseMongoUri(uri)), [expected], uri);
  }
});

test('parseMongoUri mirrors the driver: user info cannot smuggle a host, encoded / socket hosts are refused', () => {
  // Hosts are normalised the way the driver normalises them.
  assert.deepEqual(parseMongoUri('mongodb://U:p@DB.Example.com:27018,[0:0:0:0:0:0:0:1]/x').hosts,
    [{ host: 'db.example.com', port: 27018 }, { host: '::1', port: null }]);
  assert.deepEqual(parseMongoUri('mongodb://u:p%40ss@db.example.com/x').hosts, [{ host: 'db.example.com', port: null }]);
  // Forms where the driver and a naive split disagree are invalid.
  for (const uri of [
    'mongodb://evil.example.com/?@127.0.0.1',
    'mongodb://evil.example.com?@127.0.0.1/x',
    'mongodb://127.0.0.1#@evil.example.com/x',
    'mongodb://a@b@127.0.0.1/x',
    'mongodb://u:p:q@db.example.com/x',
    'mongodb://127.0.0.%31/x', // the driver would decode this to an IP literal (no DNS lookup to guard)
    'mongodb://localhos%74/x',
    'mongodb://%2Ftmp%2Fmongodb-27017.sock/x', // UNIX domain socket
    'mongodb://db.example.com:99999/x',
    'mongodb+srv://a.example.com,b.example.com/x',
    'mongodb+srv://a.example.com:27017/x',
    'http://db.example.com/x',
  ]) {
    assert.equal(parseMongoUri(uri), null, uri);
    assert.equal(validateConfig('mongodb', { uri, database: 'app', collection: 'c' }).valid, false, uri);
  }
});

test('option refusals name the option, never its value', () => {
  const verdict = validateConfig('mongodb', {
    uri: 'mongodb://db.example.com/app?authSource=admin%20hunter2&readPreference=evil.internal',
    database: 'app',
    collection: 'orders',
  });
  assert.equal(verdict.valid, false);
  const message = verdict.errors.map((e) => e.message).join(' ');
  assert.match(message, /authSource/);
  assert.match(message, /readPreference/);
  assert.equal(message.includes('hunter2'), false);
  assert.equal(message.includes('evil.internal'), false);
});

test('validateConfig rejects a mongodb URI carrying a non-allow-listed option', () => {
  const verdict = validateConfig('mongodb', {
    uri: 'mongodb://user:pw@db.example.com:27017/app?readPreference=primary&zlibCompressionLevel=9',
    database: 'app',
    collection: 'orders',
  });
  assert.equal(verdict.valid, false);
  const err = verdict.errors.find((e) => e.field === 'config.uri');
  assert.match(err.message, /not allowed or with an unsupported value: zlibCompressionLevel/);
  assert.equal(err.message.includes('pw'), false);
});

test('platform data stores are refused by endpoint (loopback aliases) and SRV domain', () => {
  const policy = platformHostPolicy({
    databaseUri: 'mongodb://127.0.0.1:27017/saas',
    redisUrl: 'redis://cache.internal.example.com:6380',
  });
  assert.equal(isPlatformHost('localhost', 27017, policy), true, 'loopback alias of the platform DB');
  assert.equal(isPlatformHost('127.0.0.1', 27018, policy), false, 'another port is not the platform DB');
  assert.equal(isPlatformHost('cache.internal.example.com', 6380, policy), true);

  const srv = platformHostPolicy({ databaseUri: 'mongodb+srv://u:p@cluster0.abcd.mongodb.net/saas', redisUrl: '' });
  assert.equal(isPlatformHost('cluster0.abcd.mongodb.net', null, srv), true);
  assert.equal(isPlatformHost('cluster0-shard-00-01.abcd.mongodb.net', 27017, srv), true, 'shard of the platform project');
  assert.equal(isPlatformHost('cluster9.zzzz.mongodb.net', 27017, srv), false, 'another Atlas project');
});

test('optional egress allow-list admits exact hosts and .suffix entries only', () => {
  const list = ['db.partner.com', '.mongodb.net'];
  assert.equal(isHostAllowListed('db.partner.com', list), true);
  assert.equal(isHostAllowListed('cluster0.abcd.mongodb.net', list), true);
  assert.equal(isHostAllowListed('evil.com', list), false);
  assert.equal(isHostAllowListed('anything.com', []), true, 'no list = any host');
});

test('assertEgressAllowed: public resolution passes; private, rebinding and unresolved hosts fail generically', async () => {
  const r = resolver({
    'db.example.com': ['8.8.8.8'],
    'rebind.example.com': ['8.8.8.8', '10.0.0.7'],
    'meta.example.com': ['169.254.169.254'],
  });
  await assertEgressAllowed([{ host: 'db.example.com', port: 27017 }], { allowPrivate: false, resolver: r, platform: NO_PLATFORM });

  await rejectsGenerically(
    assertEgressAllowed([{ host: 'rebind.example.com', port: 27017 }], { allowPrivate: false, resolver: r, platform: NO_PLATFORM }),
    ['rebind.example.com', '10.0.0.7'],
    'CONNECTOR_EGRESS_BLOCKED',
  );
  await rejectsGenerically(
    assertEgressAllowed([{ host: 'meta.example.com', port: 80 }], { allowPrivate: false, resolver: r, platform: NO_PLATFORM }),
    ['meta.example.com', '169.254.169.254'],
    'CONNECTOR_EGRESS_BLOCKED',
  );
  await rejectsGenerically(
    assertEgressAllowed([{ host: 'missing.example.com', port: 27017 }], { allowPrivate: false, resolver: r, platform: NO_PLATFORM }),
    ['missing.example.com'],
    'CONNECTOR_HOST_UNRESOLVED',
  );
  await rejectsGenerically(
    assertEgressAllowed([{ host: '127.0.0.1', port: 27017 }], { allowPrivate: false, resolver: r, platform: NO_PLATFORM }),
    ['127.0.0.1'],
    'CONNECTOR_EGRESS_BLOCKED',
  );
});

test('assertEgressAllowed refuses the platform DB even when private networks are allowed', async () => {
  const r = resolver({ 'mongo-alias.example.com': ['10.9.9.9'] });
  const platform = { endpoints: [{ host: '10.9.9.9', port: 27017 }], suffixes: [] };
  await rejectsGenerically(
    assertEgressAllowed([{ host: 'mongo-alias.example.com', port: 27017 }], { allowPrivate: true, resolver: r, platform }),
    ['10.9.9.9', 'mongo-alias'],
    'CONNECTOR_EGRESS_BLOCKED',
  );
  // Same private host, different port: allowed in a deliberately private deployment.
  await assertEgressAllowed([{ host: 'mongo-alias.example.com', port: 27018 }], { allowPrivate: true, resolver: r, platform });
});

test('assertEgressAllowed enforces the allow-list before resolving', async () => {
  const r = resolver({ 'db.example.com': ['8.8.8.8'] });
  await rejectsGenerically(
    assertEgressAllowed(['db.example.com'], { allowPrivate: false, resolver: r, platform: NO_PLATFORM, allowList: ['.partner.com'] }),
    ['db.example.com'],
    'CONNECTOR_EGRESS_BLOCKED',
  );
  assert.equal(r.calls.length, 0, 'no DNS query for a host outside the allow-list');
});

test('assertPublicMongoHosts checks SRV targets, not just the seed', async () => {
  const r = resolver(
    { 'shard-0.cluster.example.com': ['8.8.4.4'], 'shard-1.cluster.example.com': ['192.168.0.10'] },
    { '_mongodb._tcp.cluster.example.com': [
      { name: 'shard-0.cluster.example.com', port: 27017 },
      { name: 'shard-1.cluster.example.com', port: 27017 },
    ] },
  );
  await rejectsGenerically(
    assertPublicMongoHosts(parseMongoUri('mongodb+srv://u:secret@cluster.example.com/db'), { allowPrivate: false, resolver: r, platform: NO_PLATFORM }),
    ['secret', 'shard-1', '192.168.0.10'],
    'CONNECTOR_EGRESS_BLOCKED',
  );
});

test('createGuardedLookup re-checks the address actually dialled (DNS rebinding)', async () => {
  const base = (answers) => (host, opts, cb) => process.nextTick(cb, null, answers.map((address) => ({ address, family: 4 })));
  const lookup = (fn, host, opts) => new Promise((resolve) => fn(host, opts, (err, ...rest) => resolve({ err, rest })));

  const guarded = createGuardedLookup({ allowPrivate: false, baseLookup: base(['10.0.0.1']), platform: NO_PLATFORM });
  const blocked = await lookup(guarded, 'db.example.com', {});
  assert.equal(blocked.err?.code, 'CONNECTOR_EGRESS_BLOCKED');
  assert.equal(blocked.err.message.includes('10.0.0.1'), false);

  const ok = createGuardedLookup({ allowPrivate: false, baseLookup: base(['8.8.8.8']), platform: NO_PLATFORM });
  const single = await lookup(ok, 'db.example.com', {});
  assert.equal(single.err, null);
  assert.deepEqual(single.rest, ['8.8.8.8', 4]);
  const all = await lookup(ok, 'db.example.com', { all: true });
  assert.deepEqual(all.rest[0], [{ address: '8.8.8.8', family: 4 }]);

  const internalName = await lookup(ok, 'mongo', {});
  assert.equal(internalName.err?.code, 'CONNECTOR_EGRESS_BLOCKED', 'internal names refused before resolving');
});

test('the MongoDB driver dials through the guarded lookup: a rebinding hostname is refused at connect time', async () => {
  const { MongoClient } = await import('mongodb');
  const { buildClientOptions } = await import('../../src/modules/connectors/mongodb/mongodb.connector.js');
  const options = buildClientOptions();
  assert.equal(typeof options.lookup, 'function');
  assert.equal(options.maxPoolSize, 1);
  // The fake resolver answers loopback; nothing is ever dialled and no real
  // DNS query is made (the driver resolves through `lookup`).
  const asked = [];
  const fakeBase = (host, opts, cb) => {
    asked.push(host);
    process.nextTick(cb, null, [{ address: '127.0.0.1', family: 4 }]);
  };
  const client = new MongoClient('mongodb://rebind.example.com:27017/app', {
    ...options,
    serverSelectionTimeoutMS: 300,
    lookup: createGuardedLookup({ allowPrivate: false, baseLookup: fakeBase, platform: NO_PLATFORM }),
  });
  try {
    await assert.rejects(() => client.connect(), (err) => err.name === 'MongoServerSelectionError');
    assert.ok(asked.includes('rebind.example.com'), 'the driver resolved the host through the guarded lookup');
  } finally {
    await client.close();
  }
});
