# Controllers Layer

**HTTP layer only.**

Controllers parse the request, call ONE service, and return an `ApiResponse`.
They must never contain business rules or data-access code.

```js
import asyncHandler from '../../utils/asyncHandler.js';
import ApiResponse from '../../utils/ApiResponse.js';
import { getUserById } from '../../services/user.service.js';

export const me = asyncHandler(async (req, res) => {
  const user = await getUserById(req.user.id);
  return ApiResponse.ok(res, user);
});
```

Conventions
- One controller per resource, thin by design (services hold the logic).
- Wrap every async controller in `asyncHandler` (errors are centralised).
- Always reply with `ApiResponse.*`; never call `res.json()` directly.
- New features: prefer `src/modules/<feature>/<feature>.controller.js` over
  adding files here; this folder is for cross-cutting/shared endpoints.
