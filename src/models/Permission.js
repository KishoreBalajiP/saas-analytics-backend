/**
 * Permission (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Atomic authorisation: a (module, action) pair. The runtime check is
 *   `actor has permissionId on resource`. Permissions are data, not code.
 *
 * KEY SHAPE
 *   `key` is the composed unique identifier `${module}.${action}`
 *   (e.g. `iam.users.view`). The guideline "permission key MUST be
 *   `<module_key>.<action>` exactly" is enforced by the service layer;
 *   the unique index on `key` guarantees no two rows collide.
 *
 * DESIGN CONSTRAINTS
 *   - `moduleId` is the FK to `Module._id`; `module` is the denormalised
 *     module key (e.g. `iam.users`) so cache building and audit join
 *     never need an extra Module lookup. The two MUST stay consistent;
 *     the service layer keeps them in sync at creation.
 *   - `isSystem` permissions (the canonical seed) cannot be deleted while
 *     a role references them; enforced in the service layer.
 *
 * PLUGINS
 *   softDelete, paginate, optimisticConcurrency, audit (module `iam.permissions`).
 *
 * INDEXES
 *   - unique(key)
 *   - unique({ module: 1, action: 1 })
 *   - { moduleId: 1 }
 *   - { isSystem: 1 }
 */

import mongoose from 'mongoose';
import { softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'Permission';

/** Platform-defined action catalogue (uniform across every module). */
export const CANONICAL_ACTIONS = Object.freeze([
  'view', 'create', 'update', 'delete', 'export',
  'approve', 'suspend', 'restore', 'assign', 'configure', 'evaluate',
]);

const permissionSchema = new mongoose.Schema(
  {
    moduleId: { type: String, required: true, index: true },
    module: { type: String, required: true, trim: true, lowercase: true },
    action: { type: String, required: true, trim: true, lowercase: true },
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    description: { type: String, default: '' },
    isSystem: { type: Boolean, default: false, index: true },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

permissionSchema.index({ module: 1, action: 1 }, { unique: true });

permissionSchema.plugin(softDelete);
permissionSchema.plugin(paginate);
permissionSchema.plugin(optimisticConcurrency);
permissionSchema.plugin(audit, { module: 'iam.permissions' });

export const PermissionSchema = permissionSchema;
export const Permission = mongoose.model(MODEL_NAME, permissionSchema);
export default Permission;
