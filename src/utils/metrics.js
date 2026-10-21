/**
 * In-process metrics registry with Prometheus text exposition (roadmap 2.8,
 * findings ops.07 / ops2.05).
 *
 * WHY IT EXISTS
 *   Operators need request rate, error rate and latency by route, queue
 *   depth, job outcomes, analytics query latency and timeouts, quota
 *   rejections, auth failures and the email backlog to alert on. This is a
 *   small dependency-free registry (counters, gauges, histograms) rendered
 *   in the Prometheus text format 0.0.4, served at `GET /api/v1/metrics`.
 *
 * RESPONSIBILITY
 *   - `counter / gauge / histogram(name, help, labelNames, buckets?)` define
 *     (or return the already defined) metric.
 *   - `registerCollector(fn)` refreshes gauges at scrape time (queue depth,
 *     dependency status, process stats); each collector is time-boxed.
 *   - `renderPrometheus()` / `snapshot()` read the registry.
 *   - Domain helpers (`observeHttpRequest`, `observeApiError`,
 *     `observeAnalyticsQuery`, `observeJobRun`, `observeQueueJob`, ...) keep
 *     metric names and label vocabularies in one place, so the one-line
 *     hooks elsewhere in the code cannot invent unbounded labels.
 *
 * CARDINALITY
 *   Label values are bounded by construction (route templates, not URLs;
 *   error codes; job names). As a last line of defence each metric keeps at
 *   most MAX_SERIES_PER_METRIC series; further series are dropped and counted
 *   in `analivo_metrics_dropped_series_total`.
 *
 * SCOPE
 *   Values are per process. Prometheus scrapes each instance; sum across
 *   instances in queries. Queue depth comes from Redis and is cluster-wide.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';

export const METRIC_PREFIX = 'analivo_';
export const MAX_SERIES_PER_METRIC = 2000;
export const COLLECTOR_TIMEOUT_MS = 2000;
export const DEFAULT_LATENCY_BUCKETS = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]);

const NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** name -> metric */
const registry = new Map();
const collectors = new Set();
let droppedSeries = null;

/* ------------------------------- helpers -------------------------------- */

function escapeLabelValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function escapeHelp(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function formatValue(value) {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

function seriesKey(labelNames, labels) {
  return labelNames.map((name) => String(labels?.[name] ?? '')).join('\u0001');
}

function renderLabels(labelNames, values, extra = null) {
  const parts = labelNames.map((name, i) => `${name}="${escapeLabelValue(values[i])}"`);
  if (extra) parts.push(`${extra[0]}="${escapeLabelValue(extra[1])}"`);
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

/* -------------------------------- metrics -------------------------------- */

class Metric {
  constructor(type, name, help, labelNames) {
    if (!NAME_PATTERN.test(name)) throw new Error(`Invalid metric name "${name}"`);
    for (const label of labelNames) {
      if (!LABEL_PATTERN.test(label) || label === 'le') throw new Error(`Invalid label name "${label}" on ${name}`);
    }
    this.type = type;
    this.name = name;
    this.help = help;
    this.labelNames = Object.freeze([...labelNames]);
    /** key -> { values: string[], ... } */
    this.series = new Map();
  }

  /** Find or create the series for `labels`; null when over the series cap. */
  seriesFor(labels, init) {
    const key = seriesKey(this.labelNames, labels);
    let entry = this.series.get(key);
    if (!entry) {
      if (this.series.size >= MAX_SERIES_PER_METRIC) {
        if (this !== droppedSeries) droppedSeries?.inc({ metric: this.name });
        return null;
      }
      entry = { values: this.labelNames.map((name) => String(labels?.[name] ?? '')), ...init() };
      this.series.set(key, entry);
    }
    return entry;
  }

  reset() {
    this.series.clear();
  }
}

class Counter extends Metric {
  constructor(name, help, labelNames) {
    super('counter', name, help, labelNames);
  }

  inc(labels = {}, value = 1) {
    if (!Number.isFinite(value) || value < 0) return;
    const entry = this.seriesFor(labels, () => ({ value: 0 }));
    if (entry) entry.value += value;
  }

  get(labels = {}) {
    return this.series.get(seriesKey(this.labelNames, labels))?.value ?? 0;
  }

  render() {
    const lines = [];
    for (const entry of this.series.values()) {
      lines.push(`${this.name}${renderLabels(this.labelNames, entry.values)} ${formatValue(entry.value)}`);
    }
    return lines;
  }

  toJSON() {
    return Array.from(this.series.values(), (e) => ({ labels: labelObject(this.labelNames, e.values), value: e.value }));
  }
}

class Gauge extends Metric {
  constructor(name, help, labelNames) {
    super('gauge', name, help, labelNames);
  }

  set(labels = {}, value = 0) {
    if (typeof value !== 'number' || Number.isNaN(value)) return;
    const entry = this.seriesFor(labels, () => ({ value: 0 }));
    if (entry) entry.value = value;
  }

  inc(labels = {}, value = 1) {
    const entry = this.seriesFor(labels, () => ({ value: 0 }));
    if (entry) entry.value += value;
  }

  dec(labels = {}, value = 1) {
    this.inc(labels, -value);
  }

  get(labels = {}) {
    return this.series.get(seriesKey(this.labelNames, labels))?.value;
  }

  render() {
    return Counter.prototype.render.call(this);
  }

  toJSON() {
    return Counter.prototype.toJSON.call(this);
  }
}

class Histogram extends Metric {
  constructor(name, help, labelNames, buckets = DEFAULT_LATENCY_BUCKETS) {
    super('histogram', name, help, labelNames);
    const sorted = [...new Set(buckets)].filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length === 0) throw new Error(`Histogram ${name} needs at least one bucket`);
    this.buckets = Object.freeze(sorted);
  }

  observe(labels = {}, value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;
    const entry = this.seriesFor(labels, () => ({ counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 }));
    if (!entry) return;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= this.buckets[i]) entry.counts[i] += 1;
    }
    entry.sum += value;
    entry.count += 1;
  }

  /** Start a timer; the returned function observes the elapsed seconds. */
  startTimer(labels = {}) {
    const started = process.hrtime.bigint();
    return (extraLabels = {}) => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      this.observe({ ...labels, ...extraLabels }, seconds);
      return seconds;
    };
  }

  get(labels = {}) {
    const entry = this.series.get(seriesKey(this.labelNames, labels));
    return entry ? { count: entry.count, sum: entry.sum, buckets: [...entry.counts] } : { count: 0, sum: 0, buckets: [] };
  }

  render() {
    const lines = [];
    for (const entry of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i += 1) {
        lines.push(`${this.name}_bucket${renderLabels(this.labelNames, entry.values, ['le', formatValue(this.buckets[i])])} ${entry.counts[i]}`);
      }
      lines.push(`${this.name}_bucket${renderLabels(this.labelNames, entry.values, ['le', '+Inf'])} ${entry.count}`);
      lines.push(`${this.name}_sum${renderLabels(this.labelNames, entry.values)} ${formatValue(entry.sum)}`);
      lines.push(`${this.name}_count${renderLabels(this.labelNames, entry.values)} ${entry.count}`);
    }
    return lines;
  }

  toJSON() {
    return Array.from(this.series.values(), (e) => ({
      labels: labelObject(this.labelNames, e.values),
      count: e.count,
      sum: e.sum,
      buckets: Object.fromEntries(this.buckets.map((b, i) => [String(b), e.counts[i]])),
    }));
  }
}

function labelObject(names, values) {
  return Object.fromEntries(names.map((name, i) => [name, values[i]]));
}

function define(Type, name, help, labelNames = [], ...rest) {
  const existing = registry.get(name);
  if (existing) {
    if (!(existing instanceof Type)) throw new Error(`Metric "${name}" is already registered as a ${existing.type}`);
    return existing;
  }
  const metric = new Type(name, help, labelNames, ...rest);
  registry.set(name, metric);
  return metric;
}

/** Define (or fetch) a counter. */
export function counter(name, help, labelNames = []) {
  return define(Counter, name, help, labelNames);
}

/** Define (or fetch) a gauge. */
export function gauge(name, help, labelNames = []) {
  return define(Gauge, name, help, labelNames);
}

/** Define (or fetch) a histogram. */
export function histogram(name, help, labelNames = [], buckets = DEFAULT_LATENCY_BUCKETS) {
  return define(Histogram, name, help, labelNames, buckets);
}

/**
 * Register a scrape-time collector (`async () => void`) that refreshes
 * gauges. Returns an unregister function.
 *
 * @param {() => (void|Promise<void>)} fn
 * @returns {() => void}
 */
export function registerCollector(fn) {
  if (typeof fn !== 'function') throw new TypeError('registerCollector requires a function');
  collectors.add(fn);
  return () => collectors.delete(fn);
}

/** Run every collector, each bounded by `timeoutMs`; failures are counted, never thrown. */
export async function collect({ timeoutMs = COLLECTOR_TIMEOUT_MS } = {}) {
  await Promise.all(Array.from(collectors, async (fn) => {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('collector timeout')), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      collectorFailures.inc({ collector: fn.collectorName ?? fn.name ?? 'anonymous' });
    } finally {
      clearTimeout(timer);
    }
  }));
}

/**
 * Prometheus text exposition (format 0.0.4) of every registered metric,
 * after running the scrape-time collectors.
 *
 * @returns {Promise<string>}
 */
export async function renderPrometheus(options = {}) {
  await collect(options);
  const out = [];
  for (const metric of registry.values()) {
    out.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
    out.push(`# TYPE ${metric.name} ${metric.type}`);
    out.push(...metric.render());
  }
  return `${out.join('\n')}\n`;
}

/** Content type of the exposition. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * JSON view of the registry (admin monitoring page).
 *
 * @returns {Promise<{ generatedAt: string, metrics: Array<Object> }>}
 */
export async function snapshot(options = {}) {
  await collect(options);
  return {
    generatedAt: new Date().toISOString(),
    metrics: Array.from(registry.values(), (m) => ({ name: m.name, type: m.type, help: m.help, series: m.toJSON() })),
  };
}

/** Look up a registered metric (tests, diagnostics). */
export function getMetric(name) {
  return registry.get(name) ?? null;
}

/** Test hook: zero every series (definitions and collectors stay). */
export function resetMetrics() {
  for (const metric of registry.values()) metric.reset();
}

/* --------------------------- platform metrics ---------------------------- */

const p = (name) => `${METRIC_PREFIX}${name}`;

droppedSeries = counter(p('metrics_dropped_series_total'), 'Series dropped because a metric reached its series cap.', ['metric']);
const collectorFailures = counter(p('metrics_collector_failures_total'), 'Scrape-time collectors that failed or timed out.', ['collector']);

export const httpRequestsTotal = counter(
  p('http_requests_total'),
  'HTTP requests by method, route template and status code.',
  ['method', 'route', 'status'],
);
export const httpRequestDuration = histogram(
  p('http_request_duration_seconds'),
  'HTTP request latency by method, route template and status class.',
  ['method', 'route', 'status_class'],
);
export const httpRequestsInFlight = gauge(p('http_requests_in_flight'), 'HTTP requests being served now.');
export const apiErrorsTotal = counter(p('api_errors_total'), 'Error responses by error code and status.', ['code', 'status']);
export const authFailuresTotal = counter(p('auth_failures_total'), 'Authentication and session failures by reason code.', ['reason']);
export const quotaRejectionsTotal = counter(p('quota_rejections_total'), 'Requests refused by a hard plan limit, by usage metric.', ['metric']);
export const analyticsQueriesTotal = counter(
  p('analytics_queries_total'),
  'Analytics aggregations by outcome (ok, timeout, error, rejected).',
  ['outcome'],
);
export const analyticsQueryDuration = histogram(
  p('analytics_query_duration_seconds'),
  'Analytics aggregation latency by outcome (excludes time waiting for a slot).',
  ['outcome'],
);
export const jobRunsTotal = counter(p('job_runs_total'), 'Scheduled job executions by job and status.', ['job', 'status']);
export const jobRunDuration = histogram(
  p('job_run_duration_seconds'),
  'Scheduled job execution time.',
  ['job'],
  [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600],
);
export const jobLastSuccess = gauge(
  p('job_last_success_timestamp_seconds'),
  'Unix time of the last successful run of each scheduled job (from JobRun records).',
  ['job'],
);
export const queueJobsTotal = counter(
  p('queue_jobs_processed_total'),
  'Queue jobs processed in this process by queue and outcome (completed, retry, failed).',
  ['queue', 'outcome'],
);
export const queueJobDuration = histogram(
  p('queue_job_duration_seconds'),
  'Queue job processing time by queue.',
  ['queue'],
  [0.05, 0.1, 0.5, 1, 5, 15, 30, 60, 300, 900],
);
export const queueDepth = gauge(p('queue_jobs'), 'Jobs per queue and state (waiting, active, delayed, failed).', ['queue', 'state']);
export const queueUp = gauge(p('queue_up'), '1 when the queue transport answered the last scrape, else 0.', ['queue']);
export const outboxBacklog = gauge(p('outbox_backlog'), 'Outbound emails waiting to be delivered.', ['source']);
export const emailSendsTotal = counter(p('email_sends_total'), 'Email send attempts by outcome (sent, failed).', ['outcome']);
export const dependencyUp = gauge(
  p('dependency_up'),
  'Readiness of each dependency: 1 ok, 0.5 degraded, 0 down (disabled dependencies are omitted).',
  ['dependency'],
);
export const errorReportsTotal = counter(
  p('error_reports_total'),
  'Errors handed to the error reporter by source and result (sent, dropped, failed, noop).',
  ['source', 'result'],
);
export const clientErrorsTotal = counter(p('client_errors_total'), 'Frontend error reports accepted by the API.', ['kind']);
export const buildInfo = gauge(p('build_info'), 'Build and runtime information (always 1).', ['version', 'env', 'role', 'node']);
const processUptime = gauge(p('process_uptime_seconds'), 'Process uptime in seconds.');
const processRss = gauge(p('process_resident_memory_bytes'), 'Resident set size in bytes.');
const heapUsed = gauge(p('nodejs_heap_used_bytes'), 'V8 heap in use, bytes.');
const eventLoopLagP99 = gauge(p('nodejs_eventloop_lag_p99_seconds'), 'Event loop delay, 99th percentile since the previous scrape.');

let loopMonitor = null;
function processCollector() {
  if (!loopMonitor) {
    loopMonitor = monitorEventLoopDelay({ resolution: 20 });
    loopMonitor.enable();
  }
  const memory = process.memoryUsage();
  processUptime.set({}, Math.round(process.uptime()));
  processRss.set({}, memory.rss);
  heapUsed.set({}, memory.heapUsed);
  eventLoopLagP99.set({}, loopMonitor.percentile(99) / 1e9);
  loopMonitor.reset();
}
processCollector.collectorName = 'process';
registerCollector(processCollector);

/* ---------------------------- domain helpers ---------------------------- */

const ID_SEGMENT = /^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;

/**
 * Route template label for a finished request: the matched route pattern
 * with any concrete ids in the mount path replaced by `:id`. Requests that
 * matched no route are `<unmatched>` (scanners cannot create series).
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
export function routeLabel(req) {
  const routePath = req?.route?.path;
  if (routePath === undefined || routePath === null) return '<unmatched>';
  const base = String(req.baseUrl ?? '')
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) || (segment.length >= 20 && /\d/.test(segment)) ? ':id' : segment))
    .join('/');
  const pattern = Array.isArray(routePath) ? routePath.join('|') : String(routePath);
  const joined = `${base}${pattern === '/' && base ? '' : pattern}`;
  return joined || '/';
}

/** One finished HTTP request. */
export function observeHttpRequest({ method, route, status, seconds }) {
  const statusText = String(status);
  httpRequestsTotal.inc({ method, route, status: statusText });
  httpRequestDuration.observe({ method, route, status_class: `${statusText[0] ?? '0'}xx` }, seconds);
}

const AUTH_FAILURE_CODES = new Set([
  'UNAUTHORIZED',
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_NOT_ACTIVE',
  'EMAIL_NOT_VERIFIED',
  'MFA_REQUIRED',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'SESSION_COOKIE_MISSING',
  'TENANT_NOT_ACTIVE',
  'LOCKED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
]);
const CODE_LABEL = /^[A-Z][A-Z0-9_]{1,63}$/;
const METRIC_LABEL = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

/**
 * Record an error response produced by the error middleware: the error
 * code, auth failures (every 401 plus account/session codes) and plan-limit
 * rejections by usage metric.
 *
 * @param {{ statusCode: number, code?: string, errors?: Array<Object> }} error
 */
export function observeApiError(error) {
  const status = Number(error?.statusCode) || 500;
  const code = typeof error?.code === 'string' && CODE_LABEL.test(error.code) ? error.code : 'OTHER';
  apiErrorsTotal.inc({ code, status: String(status) });
  if (status === 401 || AUTH_FAILURE_CODES.has(code)) authFailuresTotal.inc({ reason: code });
  if (code === 'QUOTA_EXCEEDED') {
    const metric = error?.errors?.[0]?.metric;
    quotaRejectionsTotal.inc({ metric: typeof metric === 'string' && METRIC_LABEL.test(metric) ? metric : 'other' });
  }
}

/** One analytics aggregation. `outcome`: ok | timeout | error | rejected. */
export function observeAnalyticsQuery(outcome, seconds) {
  analyticsQueriesTotal.inc({ outcome });
  if (outcome !== 'rejected') analyticsQueryDuration.observe({ outcome }, seconds);
}

/**
 * Time one analytics aggregation (`fn` returns its promise) and record the
 * outcome: `timeout` for MongoDB MaxTimeMSExpired, `error` for any other
 * failure, `ok` otherwise. The result or error passes through unchanged.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function timeAnalyticsQuery(fn) {
  const started = process.hrtime.bigint();
  const seconds = () => Number(process.hrtime.bigint() - started) / 1e9;
  try {
    const result = await fn();
    observeAnalyticsQuery('ok', seconds());
    return result;
  } catch (err) {
    const timedOut = err?.code === 50 || err?.codeName === 'MaxTimeMSExpired';
    observeAnalyticsQuery(timedOut ? 'timeout' : 'error', seconds());
    throw err;
  }
}

/** One scheduled job execution (`status`: succeeded | failed). */
export function observeJobRun(job, status, seconds) {
  jobRunsTotal.inc({ job, status });
  jobRunDuration.observe({ job }, seconds);
  if (status === 'succeeded') jobLastSuccess.set({ job }, Math.floor(Date.now() / 1000));
}

/** One queue job attempt (`outcome`: completed | retry | failed). */
export function observeQueueJob(queue, outcome, seconds) {
  queueJobsTotal.inc({ queue, outcome });
  queueJobDuration.observe({ queue }, seconds);
}

/** One email send attempt. */
export function observeEmailSend(outcome) {
  emailSendsTotal.inc({ outcome });
}

export default {
  counter,
  gauge,
  histogram,
  registerCollector,
  collect,
  renderPrometheus,
  snapshot,
  getMetric,
  resetMetrics,
  routeLabel,
  observeHttpRequest,
  observeApiError,
  observeAnalyticsQuery,
  timeAnalyticsQuery,
  observeJobRun,
  observeQueueJob,
  observeEmailSend,
  PROMETHEUS_CONTENT_TYPE,
};
