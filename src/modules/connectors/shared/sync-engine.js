/**
 * Provider-independent sync engine.
 *
 * WHY IT EXISTS
 *   Every connector shares the same ingestion pipeline:
 *
 *       Provider records -> Normalise -> Field mapping -> Validate
 *         -> Persist ConnectorRows (batched, idempotent) -> Sync result
 *
 *   This engine owns that pipeline. Providers (CSV, Webhook, future Sheets/
 *   MongoDB) only produce *records*; they never persist anything
 *   themselves. Persistence is injected (`persist(batch)`), so unit tests
 *   can substitute an in-memory sink and future transports can swap in
 *   without touching the engine.
 *
 * STREAMING
 *   `records` may be an array OR an async iterable. Rows are consumed with
 *   `for await`, so a 1 GB CSV streams through the pipeline with bounded
 *   memory; batches are flushed every `batchSize` records.
 *
 * IDEMPOTENCY
 *   Each persisted row carries a `sourceRowId` derived by the field-mapping
 *   layer. Replays of identical source rows therefore update-in-place on
 *   the `{ connectorId, sourceRowId }` unique key instead of duplicating.
 *
 * RESULT SEMANTICS
 *   - `processed` - records read from the source.
 *   - `skipped`   - records that were NOT persisted (invalid shape or
 *     rejected by `validateRow`).
 *   - `upserted` / `matched` - persisted-row counts from the sink.
 *   - `errors`    - accumulated field-level errors for diagnostics.
 *
 * @module shared/sync-engine
 */

import { applyFieldMapping, deriveSourceRowId } from './field-mapping.js';
import { ConnectorValidationError } from './errors.js';

/**
 * Run a record batch through the ingestion pipeline.
 *
 * @param {Object} opts
 * @param {Array|AsyncIterable<Object>} opts.records - raw source records.
 * @param {Object|Array} [opts.fieldMapping] - field mapping (see field-mapping.js).
 * @param {(row: { sourceRowId: string, data: Object, raw: Object }) => Promise<{ valid: boolean, errors?: Array<Object> }>|Function} [opts.validateRow]
 *   Optional per-row validation. Rejected rows are skipped and counted.
 * @param {(batch: Array<{ sourceRowId: string, data: Object }>) => Promise<{ upserted: number, matched: number }>} [opts.persist]
 *   Persistence sink. When omitted the engine reports 0 persisted rows so
 *   it stays testable without a database.
 * @param {number} [opts.batchSize=500] - records per persist flush.
 * @returns {Promise<{ processed: number, skipped: number, upserted: number, matched: number, errors: Array<Object> }>}
 */
export async function ingestRecords({
  records = [],
  fieldMapping,
  validateRow,
  persist,
  batchSize = 500,
} = {}) {
  const isArray = Array.isArray(records);
  const isAsyncIterable = records && typeof records[Symbol.asyncIterator] === 'function';
  const isIterable = records && typeof records[Symbol.iterator] === 'function';
  if (!isArray && !isAsyncIterable && !isIterable) {
    throw new ConnectorValidationError('records must be an array or (async) iterable');
  }

  const sink = typeof persist === 'function'
    ? persist
    : async () => ({ upserted: 0, matched: 0 });

  const result = { processed: 0, skipped: 0, upserted: 0, matched: 0, errors: [] };
  let batch = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const { upserted, matched } = await sink(batch);
    result.upserted += Number(upserted) || 0;
    result.matched += Number(matched) || 0;
    batch = [];
  };

  for await (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      result.skipped += 1;
      result.errors.push({ field: 'record', message: 'source record is not an object; skipped' });
      continue;
    }
    result.processed += 1;

    const mapped = applyFieldMapping([record], fieldMapping ?? null)[0];
    const { data, errors } = mapped;

    if (typeof validateRow === 'function') {
      const verdict = await validateRow({
        sourceRowId: deriveSourceRowId(record, fieldMapping ?? null),
        data,
        raw: record,
      });
      if (verdict?.valid === false) {
        result.skipped += 1;
        result.errors.push(...(verdict.errors ?? [{ field: 'row', message: 'row failed validation' }]));
        continue;
      }
    }

    if (errors.length > 0) result.errors.push(...errors);

    batch.push({ sourceRowId: deriveSourceRowId(record, fieldMapping ?? null), data });
    if (batch.length >= batchSize) await flush();
  }

  await flush();
  return result;
}

export default { ingestRecords };
