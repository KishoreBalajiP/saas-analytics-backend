/**
 * Barrel export for shared Mongoose plugins.
 *
 * WHY IT EXISTS
 *   Feature code should import plugins from a single path so adding a new
 *   plugin (or renaming one) is a one-line change in this file.
 *
 * USAGE
 *   ```js
 *   import plugins from '../../models/plugins/index.js';
 *   schema.plugin(plugins.tenantScope);
 *   schema.plugin(plugins.softDelete);
 *   ```
 *
 * HOW TO EXTEND
 *   Add a new plugin, then re-export it from here with a JSDoc example.
 */

import tenantScope from './tenantScope.js';
import softDelete from './softDelete.js';
import optimisticConcurrency from './optimisticConcurrency.js';
import paginate from './paginate.js';
import audit from './audit.js';

export {
  tenantScope,
  softDelete,
  optimisticConcurrency,
  paginate,
  audit,
};

export default {
  tenantScope,
  softDelete,
  optimisticConcurrency,
  paginate,
  audit,
};
