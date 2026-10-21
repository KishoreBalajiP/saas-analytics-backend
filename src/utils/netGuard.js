/**
 * Outbound network guard for tenant-configured connections (egress policy).
 *
 * WHY IT EXISTS
 *   Connectors such as the external-MongoDB provider open network
 *   connections to hosts a tenant chooses. Without a guard a tenant can
 *   point the platform at loopback, private networks, cloud metadata
 *   endpoints or the platform's own database and use connection errors and
 *   timings as a scanner.
 *
 * RESPONSIBILITY (the egress policy every network connector goes through)
 *   - Classify IP addresses as public or non-public (IPv4 + IPv6, including
 *     IPv4-mapped / compatible / NAT64 / 6to4 forms).
 *   - Parse MongoDB connection strings (multi-host and SRV forms) and accept
 *     only an explicit allow-list of URI options (anything else is refused).
 *   - Refuse the platform's own MongoDB / Redis hosts, and - when
 *     `CONNECTOR_EGRESS_ALLOWED_HOSTS` is set - every host not on that list.
 *   - Resolve hostnames (and SRV targets) before connecting and refuse
 *     non-public results.
 *   - `createGuardedLookup` - a `net.connect` lookup function the driver uses
 *     for every socket, so the address actually dialled is checked at connect
 *     time. This closes the DNS-rebinding gap between the pre-flight check
 *     and the driver's own resolution.
 *
 * ERRORS
 *   Every refusal is an `EgressBlockedError` / `ConnectorError` with a
 *   generic message. Messages never echo the host, the resolved address or
 *   the connection string.
 *
 * LIMITS
 *   An egress firewall at the hosting layer remains the stronger control;
 *   this module is defence in depth inside the application.
 */

import dnsCallback from 'node:dns';
import dns from 'node:dns/promises';
import net from 'node:net';
import env from '../config/env.js';
import { ConnectorError, EgressBlockedError } from '../modules/connectors/shared/errors.js';

const UNRESOLVED_CODE = 'CONNECTOR_HOST_UNRESOLVED';
const BLOCKED_MESSAGE = 'The MongoDB host is not allowed. Use a publicly reachable host.';
const UNRESOLVED_MESSAGE = 'The MongoDB host could not be resolved.';

/* ------------------------------ addresses -------------------------------- */

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}

const IPV4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0 }));

/** Expand an IPv6 literal into 8 numeric hextets (null when malformed). */
function expandIpv6(address) {
  let a = address.toLowerCase();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  // Trailing dotted IPv4 (e.g. ::ffff:127.0.0.1) -> two hextets.
  const dotted = a.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v = ipv4ToInt(dotted[1]);
    a = `${a.slice(0, -dotted[1].length)}${(v >>> 16).toString(16)}:${(v & 0xffff).toString(16)}`;
  }
  const [head, tail] = a.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = a.includes('::') ? 8 - headParts.length - tailParts.length : 0;
  const parts = [...headParts, ...Array(Math.max(missing, 0)).fill('0'), ...tailParts];
  if (parts.length !== 8) return null;
  const nums = parts.map((p) => Number.parseInt(p, 16));
  return nums.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff) ? null : nums;
}

function embeddedIpv4(h1, h2) {
  return `${h1 >>> 8}.${h1 & 0xff}.${h2 >>> 8}.${h2 & 0xff}`;
}

/** True when the address is loopback, private, link-local, reserved or otherwise not public. */
export function isNonPublicAddress(address) {
  if (net.isIPv4(address)) {
    const value = ipv4ToInt(address);
    return IPV4_BLOCKED.some(({ base, mask }) => (value & mask) === (base & mask));
  }
  if (net.isIPv6(address)) {
    const h = expandIpv6(address);
    if (!h) return true;
    const firstSixZero = h.slice(0, 6).every((x) => x === 0);
    if (firstSixZero && h[6] === 0 && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
    if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return isNonPublicAddress(embeddedIpv4(h[6], h[7])); // IPv4-mapped
    if (firstSixZero) return isNonPublicAddress(embeddedIpv4(h[6], h[7])); // IPv4-compatible (deprecated)
    if (h[0] === 0x64 && h[1] === 0xff9b) return true; // NAT64 - can reach any IPv4 behind the gateway
    if (h[0] === 0x2002) return isNonPublicAddress(embeddedIpv4(h[1], h[2])); // 6to4
    if (h[0] === 0x2001 && h[1] === 0x0000) return true; // Teredo
    if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
    if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true; // discard-only
    if ((h[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
    if ((h[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((h[0] & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
    if ((h[0] & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return true;
}

/* --------------------------- connection strings --------------------------- */

// Same split the MongoDB driver uses (`mongodb-connection-string-url`), so
// the guard checks exactly the hosts the driver will dial.
const MONGO_URI_RE = /^(?<protocol>[^/]+):\/\/(?:(?<username>[^:@]*)(?::(?<password>[^@]*))?@)?(?<hosts>(?!:)[^/?@]*)(?<rest>.*)$/s;
// Characters the driver refuses unescaped in the user info.
const USERINFO_ILLEGAL = /[:/?#[\]@]/;

/**
 * Normalise one `host[:port]` entry the way the driver does (WHATWG URL with
 * an opaque scheme). Refuses forms whose meaning can differ between this
 * guard and the driver: percent-encoded or whitespace hosts (the driver
 * decodes them, so `127.0.0.%31` would become an IP literal that never goes
 * through the DNS lookup) and `.sock` hosts (UNIX domain sockets).
 */
function parseHostAddress(raw) {
  const value = String(raw ?? '');
  if (!value || /[\s%]/.test(value) || /\.sock$/i.test(value)) return null;
  let url;
  try {
    url = new URL(`ilovejs://${value}`);
  } catch {
    return null;
  }
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) return null;
  const port = url.port === '' ? null : Number.parseInt(url.port, 10);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
  return { host, port };
}

/**
 * Split a MongoDB connection string into scheme, hosts and options, with the
 * driver's own rules (user info cannot hide a second host, hosts are
 * normalised like the driver normalises them). Options are read from the
 * first `?` to the end of the string, a superset of what the driver reads.
 *
 * @returns {{ srv: boolean, hosts: Array<{ host: string, port: number|null }>, options: URLSearchParams } | null}
 */
export function parseMongoUri(uri) {
  const match = MONGO_URI_RE.exec(String(uri ?? '').trim());
  if (!match) return null;
  const { protocol, username, password, hosts: hostList, rest = '' } = match.groups;
  const scheme = protocol.toLowerCase();
  if (scheme !== 'mongodb' && scheme !== 'mongodb+srv') return null;
  if (!hostList) return null;
  if (username !== undefined && USERINFO_ILLEGAL.test(username)) return null;
  if (password !== undefined && USERINFO_ILLEGAL.test(password)) return null;
  if (/^[^/?]*@/.test(rest)) return null;
  const queryIndex = rest.indexOf('?');
  const options = new URLSearchParams(queryIndex >= 0 ? rest.slice(queryIndex + 1) : '');
  const hosts = [];
  for (const part of hostList.split(',')) {
    const parsed = parseHostAddress(part);
    if (!parsed) return null;
    hosts.push(parsed);
  }
  const srv = scheme === 'mongodb+srv';
  if (srv && (hosts.length !== 1 || hosts[0].port !== null)) return null;
  return { srv, hosts, options };
}

const isBool = (v) => v === 'true' || v === 'false';
const isPositiveInt = (v) => /^\d{1,9}$/.test(v);
const oneOf = (...values) => (v) => values.includes(v.toLowerCase());

/**
 * The ONLY connection-string options a tenant may set, each with a value
 * check. Everything else (proxy, TLS bypass / file options, credential
 * fetching mechanisms, SRV service overrides, timeouts and pool sizes we set
 * ourselves...) is refused. Keys are matched case-insensitively.
 */
export const ALLOWED_MONGO_OPTIONS = Object.freeze({
  authsource: (v) => /^[A-Za-z0-9_$.-]{1,64}$/.test(v),
  authmechanism: oneOf('scram-sha-1', 'scram-sha-256', 'default'),
  replicaset: (v) => /^[A-Za-z0-9_.-]{1,128}$/.test(v),
  tls: isBool,
  ssl: isBool,
  retrywrites: isBool,
  retryreads: isBool,
  w: (v) => v === 'majority' || /^\d{1,2}$/.test(v),
  journal: isBool,
  wtimeoutms: isPositiveInt,
  readpreference: oneOf('primary', 'primarypreferred', 'secondary', 'secondarypreferred', 'nearest'),
  maxstalenessseconds: (v) => v === '-1' || isPositiveInt(v),
  readconcernlevel: oneOf('local', 'majority', 'available', 'linearizable', 'snapshot'),
  appname: (v) => /^[\w .-]{1,64}$/.test(v),
  directconnection: isBool,
  srvmaxhosts: isPositiveInt,
  compressors: (v) => v.split(',').every((c) => ['zlib', 'none'].includes(c.trim().toLowerCase())),
});

/**
 * Options in the parsed connection string that are not on the allow-list
 * (or carry a value the allow-list refuses). Returned as option NAMES only,
 * e.g. `proxyHost` or `authMechanism`: values are never echoed (they can
 * carry hosts or secrets).
 */
export function disallowedMongoOptions(parsed) {
  if (!parsed) return [];
  const rejected = new Set();
  for (const [key, value] of parsed.options.entries()) {
    const check = ALLOWED_MONGO_OPTIONS[key.toLowerCase()];
    const name = /^[A-Za-z0-9_.-]{1,64}$/.test(key) ? key : 'unknown option';
    if (!check || !check(String(value))) rejected.add(name);
  }
  return [...rejected];
}

/** @deprecated Kept for callers of the Phase 0 deny-list; same as `disallowedMongoOptions`. */
export const forbiddenMongoOptions = disallowedMongoOptions;

/* ------------------------------- host policy ------------------------------ */

/** True when a hostname is obviously internal (or IP-like) without resolving it. */
export function isObviouslyInternalHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (net.isIP(h)) return isNonPublicAddress(h);
  // Numeric / hex host names (`127.1`, `0x7f.1`, `2130706433`) are parsed as
  // IPv4 by the system resolver; refuse anything that is not a canonical IP.
  if (/^[0-9.]+$/.test(h) || /(^|\.)0x[0-9a-f]*(\.|$)/.test(h)) return true;
  return h === 'localhost'
    || h.endsWith('.localhost')
    || h.endsWith('.local')
    || h.endsWith('.internal')
    || h.endsWith('.localdomain')
    || h.endsWith('.home.arpa')
    || !h.includes('.');
}

const LOOPBACK = 'loopback';

/** Normalise a host for endpoint comparison (loopback aliases collapse). */
function normaliseHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return LOOPBACK;
  if (net.isIP(h) && (h.startsWith('127.') || h === '::1' || h === '0.0.0.0' || h === '::')) return LOOPBACK;
  return h;
}

function endpointsOfUri(uri) {
  if (!uri) return [];
  if (/^mongodb/i.test(uri)) {
    const parsed = parseMongoUri(uri);
    if (!parsed) return [];
    return parsed.hosts.map((h) => ({ host: h.host.toLowerCase(), port: h.port ?? 27017, srv: parsed.srv }));
  }
  try {
    const url = new URL(uri);
    if (!url.hostname) return [];
    return [{ host: url.hostname.toLowerCase().replace(/^\[|\]$/g, ''), port: Number(url.port) || 6379, srv: false }];
  } catch {
    return [];
  }
}

/**
 * The platform's own data stores. A tenant connector must never reach them,
 * even when they are public (e.g. an Atlas cluster) or when private networks
 * are deliberately allowed: exact host:port endpoints, plus the project
 * domain of an SRV seed (`cluster0.abcd.mongodb.net` -> `.abcd.mongodb.net`)
 * so individual shard hosts are refused too.
 */
export function platformHostPolicy({ databaseUri = env.database?.uri, redisUrl = env.redis?.url } = {}) {
  const endpoints = [];
  const suffixes = [];
  for (const { host, port, srv } of [...endpointsOfUri(databaseUri), ...endpointsOfUri(redisUrl)]) {
    if (srv) {
      // SRV seeds resolve to other host names: refuse the seed and its domain.
      suffixes.push(host);
      if (host.split('.').length >= 3) suffixes.push(`.${host.split('.').slice(1).join('.')}`);
    } else {
      endpoints.push({ host, port });
    }
  }
  return { endpoints, suffixes };
}

/**
 * True when `host[:port]` is one of the platform's own data-store
 * endpoints. With no port only the domain rules apply.
 */
export function isPlatformHost(host, port, policy = platformHostPolicy()) {
  const raw = String(host ?? '').toLowerCase().replace(/\.$/, '');
  if (policy.suffixes.some((s) => (s.startsWith('.') ? raw.endsWith(s) : raw === s))) return true;
  if (port === undefined || port === null) return false;
  const h = normaliseHost(raw);
  return policy.endpoints.some((e) => normaliseHost(e.host) === h && Number(e.port) === Number(port));
}

/** True when the optional egress allow-list admits `host` (no list = all hosts). */
export function isHostAllowListed(host, allowList = env.connectors.egressAllowedHosts) {
  if (!Array.isArray(allowList) || allowList.length === 0) return true;
  const h = String(host ?? '').toLowerCase().replace(/\.$/, '');
  return allowList.some((entry) => {
    const e = String(entry).toLowerCase().trim();
    if (!e) return false;
    return e.startsWith('.') ? h.endsWith(e) : h === e;
  });
}

/**
 * Synchronous policy check usable at validation time (no DNS): platform
 * endpoints, allow-list and, unless private networks are allowed, obviously
 * internal names. Returns a generic reason or null.
 */
export function hostPolicyViolation(host, port, { allowPrivate = env.connectors.allowPrivateNetworks, allowList, platform } = {}) {
  if (isPlatformHost(host, port, platform)) return 'the host is not allowed';
  if (!isHostAllowListed(host, allowList)) return 'the host is not on the allowed list';
  if (!allowPrivate && isObviouslyInternalHost(host)) return 'the host must be a public address';
  return null;
}

/* ------------------------------ resolution -------------------------------- */

const defaultResolver = Object.freeze({
  lookup: (host) => dns.lookup(host, { all: true, verbatim: true }),
  resolveSrv: (name) => dns.resolveSrv(name),
});

/** Resolved addresses of the platform's own endpoints (best effort). */
async function platformAddresses(policy, resolver) {
  const out = [];
  for (const e of policy.endpoints) {
    const addresses = net.isIP(e.host)
      ? [{ address: e.host }]
      : await resolver.lookup(e.host).catch(() => []);
    for (const { address } of Array.isArray(addresses) ? addresses : []) out.push({ address, port: Number(e.port) });
  }
  return out;
}

const toEndpoint = (h) => (typeof h === 'string' ? { host: h, port: null } : { host: h.host, port: h.port ?? null });

/**
 * Resolve and check every endpoint. Throws a generic `EgressBlockedError`
 * when any endpoint violates the policy or resolves to a non-public
 * address (or to one of the platform's own endpoints).
 *
 * @param {Array<string|{ host: string, port?: number|null }>} hosts
 * @param {Object} [opts]
 * @param {boolean} [opts.allowPrivate]
 * @param {{ lookup: Function, resolveSrv?: Function }} [opts.resolver] - injectable for tests.
 * @param {string[]} [opts.allowList]
 * @param {Object} [opts.platform] - `platformHostPolicy()` output.
 */
export async function assertEgressAllowed(hosts, {
  allowPrivate = env.connectors.allowPrivateNetworks,
  resolver = defaultResolver,
  allowList,
  platform = platformHostPolicy(),
} = {}) {
  let platformResolved = null;
  for (const item of hosts) {
    const { host, port } = toEndpoint(item);
    if (hostPolicyViolation(host, port, { allowPrivate, allowList, platform })) throw new EgressBlockedError(BLOCKED_MESSAGE);
    const addresses = net.isIP(host) ? [{ address: host }] : await resolver.lookup(host).catch(() => []);
    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw new ConnectorError(UNRESOLVED_CODE, UNRESOLVED_MESSAGE, { statusCode: 400 });
    }
    if (!allowPrivate && addresses.some(({ address }) => isNonPublicAddress(address))) {
      throw new EgressBlockedError(BLOCKED_MESSAGE);
    }
    if (port !== null && platform.endpoints.length > 0) {
      platformResolved ??= await platformAddresses(platform, resolver);
      const hit = addresses.some(({ address }) => platformResolved.some((p) => p.port === Number(port)
        && normaliseHost(p.address) === normaliseHost(address)));
      if (hit) throw new EgressBlockedError(BLOCKED_MESSAGE);
    }
  }
}

/**
 * Resolve every host the driver may contact (SRV targets included) and
 * refuse anything the egress policy does not allow.
 *
 * @throws {EgressBlockedError|ConnectorError} with a generic message.
 */
export async function assertPublicMongoHosts(parsed, {
  allowPrivate = env.connectors.allowPrivateNetworks,
  resolver = defaultResolver,
  allowList,
  platform = platformHostPolicy(),
} = {}) {
  if (!parsed) throw new ConnectorError('CONFIG_INVALID', 'Invalid MongoDB connection string', { statusCode: 400 });
  // The seed host itself is subject to the platform / allow-list policy even
  // in SRV form (it is what the tenant typed).
  for (const seed of parsed.hosts) {
    const port = parsed.srv ? null : (seed.port ?? 27017);
    if (hostPolicyViolation(seed.host, port, { allowPrivate, allowList, platform })) throw new EgressBlockedError(BLOCKED_MESSAGE);
  }
  let endpoints = parsed.hosts.map((h) => ({ host: h.host, port: h.port ?? 27017 }));
  if (parsed.srv) {
    const records = await resolver.resolveSrv(`_mongodb._tcp.${parsed.hosts[0].host}`).catch(() => []);
    if (!Array.isArray(records) || records.length === 0) {
      throw new ConnectorError(UNRESOLVED_CODE, UNRESOLVED_MESSAGE, { statusCode: 400 });
    }
    endpoints = records.map((r) => ({ host: r.name, port: r.port ?? 27017 }));
  }
  await assertEgressAllowed(endpoints, { allowPrivate, resolver, allowList, platform });
}

/**
 * Build a `lookup` function for `net.connect` / the MongoDB driver that
 * applies the egress policy to the address actually dialled. Honours both
 * the single-address and the `all: true` (happy-eyeballs) call forms.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.allowPrivate]
 * @param {Function} [opts.baseLookup] - defaults to `dns.lookup` (injectable for tests).
 */
export function createGuardedLookup({
  allowPrivate = env.connectors.allowPrivateNetworks,
  baseLookup = dnsCallback.lookup,
  allowList,
  platform,
} = {}) {
  return function guardedLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options !== null ? options : {};
    // The port is not known here, so only the name-based rules apply; the
    // endpoint rules ran in the pre-flight check.
    if (hostPolicyViolation(hostname, null, { allowPrivate, allowList, platform })) {
      return process.nextTick(cb, new EgressBlockedError(BLOCKED_MESSAGE));
    }
    return baseLookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return cb(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
      if (list.length === 0 || (!allowPrivate && list.some(({ address }) => isNonPublicAddress(address)))) {
        return cb(new EgressBlockedError(BLOCKED_MESSAGE));
      }
      if (opts.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}

export default {
  isNonPublicAddress,
  parseMongoUri,
  disallowedMongoOptions,
  forbiddenMongoOptions,
  isObviouslyInternalHost,
  platformHostPolicy,
  isPlatformHost,
  isHostAllowListed,
  hostPolicyViolation,
  assertEgressAllowed,
  assertPublicMongoHosts,
  createGuardedLookup,
  ALLOWED_MONGO_OPTIONS,
};
