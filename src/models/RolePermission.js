/**
 * RolePermission (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Join row: which permission a role has. Permission assignment NEVER
 *   mutates the Permission document - it only adds/removes join rows.
 *
 * DESIGN CONSTRAINTS
 *   - Unique (roleId, permissionId): a role cannot hold the same
 *     permission twice. `grantedBy` / `grantedAt` document who granted it.
 *   - Membership is always resolved through the service layer, which
 *     invalidates the `iam:rbac:<scope>` cache on every write.
 *
 * PLUGINS
 *   softDelete, paginate, optimisticConcurrency, audit (module `iam.roles`).
 *
 * INDEXES
 *   - unique({ roleId: 1, permissionId: 1 })
 */

import mongoose from 'mongoose';
import { softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'RolePermission';

const rolePermissionSchema = new mongoose.Schema(
  {
    roleId: { type: String, required: true, index: true },
    permissionId: { type: String, required: true, index: true },
    grantedBy: { type: String, default: null },
    grantedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

rolePermissionSchema.index({ roleId: 1, permissionId: 1 }, { unique: true });

rolePermissionSchema.plugin(softDelete);
rolePermissionSchema.plugin(paginate);
rolePermissionSchema.plugin(optimisticConcurrency);
rolePermissionSchema.plugin(audit, { module: 'iam.roles' });

export const RolePermissionSchema = rolePermissionSchema;
export const RolePermission = mongoose.model(MODEL_NAME, rolePermissionSchema);
export default RolePermission;
