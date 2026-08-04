# Services Layer

**Business logic layer.**

Services orchestrate repositories, apply business rules, and throw
`ApiError` on violation. They know nothing about HTTP (`req`/`res`) or
Mongoose schemas - that makes them unit-testable and reusable across HTTP
routes, socket events and background jobs.

```js
import ApiError from '../../utils/ApiError.js';
import { findOne, create } from '../repositories/tenant.repository.js';

export async function createTenant({ name }) {
  if (await findOne({ name })) {
    throw ApiError.conflict('A tenant with this name already exists');
  }
  return create({ name });
}
```

Conventions
- One service per resource/feature; keep functions small and single-purpose.
- Throw `ApiError` factories for all expected failures.
- Never import `express` types; return plain data / domain objects.
- New features: prefer `src/modules/<feature>/<feature>.service.js`.
