/**
 * Queue instrumentation: trace propagation, job metrics and error reporting
 * for every queue transport (roadmap 2.8).
 *
 * WHY IT EXISTS
 *   A support ticket quotes the request id of an upload or a "run now"
 *   click; the work itself happens later in a queue job, possibly on the
 *   worker service. Producers therefore copy the active trace context into
 *   the job (`data._trace`) and consumers run the handler inside a child
 *   context of that trace, so every log line the job writes carries the
 *   originating `requestId` and `traceId` (plus `queue` and `jobId`).
 *
 * RESPONSIBILITY
 *   - `withTraceCarrier(data)`        producer side: add `_trace` to a plain
 *                                     object payload (other payloads pass
 *                                     through untouched; an existing
 *                                     `_trace` is kept).
 *   - `instrumentConsumer(queue, fn)` consumer side: run `fn(job)` in the
 *                                     job's trace context, record duration
 *                                     and outcome (completed / retry /
 *                                     failed) and report jobs that ran out
 *                                     of attempts to the error reporter.
 *
 * Both are one-line hooks in `queues/index.js`, so the in-memory and BullMQ
 * transports behave the same.
 */

import { currentTraceCarrier, childTraceContext, runWithTrace } from '../utils/traceContext.js';
import { observeQueueJob } from '../utils/metrics.js';
import { reportError } from '../services/errorReporter.service.js';

export const TRACE_FIELD = '_trace';

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Copy the active trace context into a job payload.
 *
 * @template T
 * @param {T} data
 * @returns {T}
 */
export function withTraceCarrier(data) {
  if (!isPlainObject(data) || data[TRACE_FIELD]) return data;
  const carrier = currentTraceCarrier();
  return carrier ? { ...data, [TRACE_FIELD]: carrier } : data;
}

/**
 * Wrap a queue consumer handler.
 *
 * @param {string} queue - queue name (bounded metric label).
 * @param {(job: Object) => Promise<any>} handler
 * @returns {(job: Object) => Promise<any>}
 */
export function instrumentConsumer(queue, handler) {
  if (typeof handler !== 'function') return handler;
  return function instrumentedConsumer(job) {
    const carrier = isPlainObject(job?.data) ? job.data[TRACE_FIELD] : null;
    const context = childTraceContext(carrier, {
      queue,
      ...(job?.id !== undefined && job?.id !== null ? { jobId: String(job.id) } : {}),
    });
    return runWithTrace(context, async () => {
      const started = process.hrtime.bigint();
      const seconds = () => Number(process.hrtime.bigint() - started) / 1e9;
      try {
        const result = await handler(job);
        observeQueueJob(queue, 'completed', seconds());
        return result;
      } catch (err) {
        const attempts = Number(job?.attempts) || 1;
        const attemptsMade = (Number(job?.attemptsMade) || 0) + 1;
        const final = attemptsMade >= attempts;
        observeQueueJob(queue, final ? 'failed' : 'retry', seconds());
        if (final) {
          // Only jobs that exhausted their retries are worth an alert.
          void reportError(err, {
            source: 'queue',
            extra: { queue, jobName: job?.name ?? null, attempts, attemptsMade },
          });
        }
        throw err;
      }
    });
  };
}

export default { withTraceCarrier, instrumentConsumer, TRACE_FIELD };
