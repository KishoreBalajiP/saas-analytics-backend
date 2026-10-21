/**
 * Audit Chain Service (roadmap 2.5; finding gov.13).
 *
 * PURPOSE
 *   Verifies the audit trail's hash chain (see `utils/auditChain.js` for how
 *   rows are sealed). Read-only: it never writes, so it can run against a
 *   production replica with a read-only user.
 *
 * WHAT IS CHECKED
 *   For every row that carries a `seq`, in `seq` order:
 *     - `seq_gap`            a sequence number is missing (row deleted);
 *     - `prev_hash_mismatch` `prevHash` is not the previous row's `hash`
 *                            (row deleted or inserted, or a hash rewritten);
 *     - `hash_mismatch`      the stored hash does not match the row's
 *                            content (row edited);
 *     - `genesis_mismatch`   the row with seq 1 does not start from the
 *                            genesis hash.
 *   Plus `unchained_record`: a row without chain data written after the
 *   chain began (inserted around the repository). Rows written before the
 *   chain existed are reported as `legacyUnchained`, not as errors.
 *   HMAC-sealed rows whose key is not configured are counted as
 *   `unverifiable` (configure `AUDIT_CHAIN_KEY` / `AUDIT_CHAIN_PREVIOUS_KEYS`).
 *
 *   If the oldest rows were removed by the retention purge, the first
 *   remaining row is the anchor (`anchored: true`) and links are checked
 *   from there. Truncation of the NEWEST rows cannot be seen from inside the
 *   chain; pass `expectHead` (a `{ seq, hash }` recorded earlier, e.g. by
 *   a scheduled run of `scripts/ci/verify-audit-chain.js`) to detect it.
 *
 * USAGE
 *   const report = await verifyAuditChain();
 *   if (!report.ok) alert(report.errors);
 */

import auditLogRepository from '../repositories/auditLog.repository.js';
import { GENESIS_HASH, checkRow, signingKeys } from '../utils/auditChain.js';

const MAX_REPORTED_ERRORS = 100;

/**
 * Walk the chain and report every broken link.
 *
 * @param {Object} [opts]
 * @param {number} [opts.batchSize=500]
 * @param {Map<string,string>} [opts.keysById] - HMAC keys by keyId
 *   (defaults to AUDIT_CHAIN_KEY + AUDIT_CHAIN_PREVIOUS_KEYS).
 * @param {{ seq: number, hash: string }} [opts.expectHead] - a head recorded
 *   earlier; the chain must still contain it unchanged.
 * @returns {Promise<{
 *   ok: boolean, checked: number, firstSeq: number|null, lastSeq: number|null,
 *   head: { seq: number, hash: string }|null, anchored: boolean,
 *   legacyUnchained: number, unverifiable: number, errorCount: number,
 *   errors: Array<{ type: string, seq?: number, id?: string, detail?: string }>
 * }>}
 */
export async function verifyAuditChain({ batchSize = 500, keysById = signingKeys().byId, expectHead = null } = {}) {
  const errors = [];
  let errorCount = 0;
  const report = (error) => {
    errorCount += 1;
    if (errors.length < MAX_REPORTED_ERRORS) errors.push(error);
  };

  let checked = 0;
  let unverifiable = 0;
  let first = null;
  let previous = null;
  let expectedHeadSeen = false;

  const cursor = auditLogRepository.streamChain({ batchSize });
  try {
    for await (const row of cursor) {
      checked += 1;
      const id = String(row._id);
      if (!first) {
        first = row;
        if (row.seq === 1 && row.prevHash !== GENESIS_HASH) {
          report({ type: 'genesis_mismatch', seq: row.seq, id });
        }
      } else {
        if (row.seq !== previous.seq + 1) {
          report({ type: 'seq_gap', seq: row.seq, id, detail: `expected seq ${previous.seq + 1}` });
        }
        if (row.prevHash !== previous.hash) {
          report({ type: 'prev_hash_mismatch', seq: row.seq, id });
        }
      }

      const result = checkRow(row, keysById);
      if (result.status === 'mismatch') report({ type: 'hash_mismatch', seq: row.seq, id });
      if (result.status === 'unverifiable') unverifiable += 1;

      if (expectHead && row.seq === Number(expectHead.seq)) {
        expectedHeadSeen = true;
        if (row.hash !== expectHead.hash) {
          report({ type: 'expected_head_mismatch', seq: row.seq, id });
        }
      }
      previous = row;
    }
  } finally {
    await cursor.close?.();
  }

  if (expectHead && !expectedHeadSeen) {
    report({
      type: 'expected_head_missing',
      seq: Number(expectHead.seq),
      detail: 'the recorded head is no longer in the chain (rows after it were removed, or it was purged)',
    });
  }

  // Rows without chain data written after the chain began were inserted
  // around the repository (or by someone with database access).
  const chainStart = first?.occurredAt ?? null;
  let legacyUnchained = 0;
  if (chainStart) {
    const strays = await auditLogRepository.countUnchainedSince(chainStart);
    if (strays > 0) {
      const sample = await auditLogRepository.findUnchainedSince(chainStart, 20);
      for (const row of sample) {
        report({ type: 'unchained_record', id: String(row._id), detail: `${row.module}/${row.action}` });
      }
      errorCount += Math.max(0, strays - sample.length);
    }
    const total = await auditLogRepository.countUnchainedSince(null);
    legacyUnchained = total - strays;
  } else {
    legacyUnchained = await auditLogRepository.countUnchainedSince(null);
  }

  return {
    ok: errorCount === 0,
    checked,
    firstSeq: first?.seq ?? null,
    lastSeq: previous?.seq ?? null,
    head: previous ? { seq: previous.seq, hash: previous.hash } : null,
    anchored: Boolean(first && first.seq !== 1),
    legacyUnchained,
    unverifiable,
    errorCount,
    errors,
  };
}

export default { verifyAuditChain };
