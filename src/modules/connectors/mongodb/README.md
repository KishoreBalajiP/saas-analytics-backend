# Connector: MongoDB (customer databases)

Planned scope - NOT implemented in Phase 1.1.

The platform will later let tenants connect **their own MongoDB Atlas
database** so their collections become analytics data. This connector is
architected now; nothing is implemented.

## Future capabilities

| Capability          | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| Connection URI      | accept a tenant-supplied Atlas connection string           |
| Database selection  | list + choose a database                                   |
| Collection selection| list + choose collections to sync                          |
| Preview documents   | sample N documents + derive field types                    |
| Field mapping       | map source fields to target analytics fields (`shared/`)   |
| Synchronization     | batched sync via `src/queues/connector.queue.js`           |
| Disconnect          | close driver connections and clear pooled resources        |

## Security requirements (design constraints, not implemented)

- Connection strings are **secrets**: store only encrypted values through
  `utils/encryption.js`; never log or return them.
- The tenant's database is a third party: always connect read-only where
  possible, cap result sizes, and never proxy arbitrary queries.
- Keep pool sizes small and per-connector (many tenants x many connectors).
- The platform's own MongoDB connection (`config/database.js`) is separate
  from tenant connector connections and must never be confused with them.

## How it will be implemented

```js
import BaseConnector from '../../../connectors/BaseConnector.js';

export default class MongoDbConnector extends BaseConnector {
  static type = 'mongodb';
  static displayName = 'MongoDB Atlas';
  // connect, validate, preview, ingest, disconnect
}
```

The driver (`mongodb`) is already a transitive dependency of mongoose, so no
new runtime dependency is required to build this connector later.
