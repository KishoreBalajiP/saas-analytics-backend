/**
 * External API Validators (Sprint 9 - implemented).
 *
 * PURPOSE
 *   Query parameter validation for the X-Api-Key surface. The external API
 *   uses GET with query params for analytics queries to be cacheable and
 *   bookmarkable.
 */

export function validateQueryDataset(query) {
  const errors = [];
  if (query.filters !== undefined) {
    try {
      JSON.parse(query.filters);
    } catch {
      errors.push({ field: 'filters', message: 'filters must be valid JSON' });
    }
  }
  if (query.filtersOp !== undefined && !['and', 'or'].includes(query.filtersOp)) {
    errors.push({ field: 'filtersOp', message: 'filtersOp must be "and" or "or"' });
  }
  if (query.dateRange !== undefined) {
    try {
      const dr = JSON.parse(query.dateRange);
      if (!dr?.from || !dr?.to) {
        errors.push({ field: 'dateRange', message: 'dateRange must have from and to' });
      }
    } catch {
      errors.push({ field: 'dateRange', message: 'dateRange must be valid JSON' });
    }
  }
  if (query.metrics !== undefined) {
    try {
      JSON.parse(query.metrics);
    } catch {
      errors.push({ field: 'metrics', message: 'metrics must be valid JSON' });
    }
  }
  if (query.groupBy !== undefined) {
    try {
      JSON.parse(query.groupBy);
    } catch {
      errors.push({ field: 'groupBy', message: 'groupBy must be valid JSON' });
    }
  }
  if (query.orderBy !== undefined) {
    try {
      JSON.parse(query.orderBy);
    } catch {
      errors.push({ field: 'orderBy', message: 'orderBy must be valid JSON' });
    }
  }
  if (query.pagination !== undefined) {
    try {
      JSON.parse(query.pagination);
    } catch {
      errors.push({ field: 'pagination', message: 'pagination must be valid JSON' });
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateListDatasets(query) {
  const errors = [];
  if (query.page !== undefined) {
    const n = Number(query.page);
    if (!Number.isInteger(n) || n < 1) errors.push({ field: 'page', message: 'page must be a positive integer' });
  }
  if (query.limit !== undefined) {
    const n = Number(query.limit);
    if (!Number.isInteger(n) || n < 1 || n > 200) errors.push({ field: 'limit', message: 'limit must be 1-200' });
  }
  return { valid: errors.length === 0, errors };
}

export function validateListDatasetRows(query) {
  const errors = [];
  if (query.page !== undefined) {
    const n = Number(query.page);
    if (!Number.isInteger(n) || n < 1) errors.push({ field: 'page', message: 'page must be a positive integer' });
  }
  if (query.limit !== undefined) {
    const n = Number(query.limit);
    if (!Number.isInteger(n) || n < 1 || n > 500) errors.push({ field: 'limit', message: 'limit must be 1-500' });
  }
  return { valid: errors.length === 0, errors };
}

export default { validateQueryDataset, validateListDatasets, validateListDatasetRows };