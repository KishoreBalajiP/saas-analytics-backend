# 21. Verification log

Every command executed during this audit, in order, with what it touched and what it returned. Commands that would have changed application state, external services, or production were **not** run and are listed at the end.

Machine: macOS (Darwin 27.0.0), Node **v26.7.0**, npm **11.19.0**. Note that `backend/package.json` declares `engines.node >= 20`; the repository documentation was written against Node 20/22. Two of the three test failures below are attributable to this version difference (see TST-001 in `19-findings-register.md`).

## 1. Repository state (read-only)

| Command | Repo | Result |
|---|---|---|
| `git status --short` | backend | clean |
| `git status --short` | frontend | clean |
| `git branch -a` | both | `main`, tracking `origin/main` |
| `git remote -v` | backend | `git@github.com:KishoreBalajiP/saas-analytics-backend.git` |
| `git remote -v` | frontend | `git@github.com:KishoreBalajiP/saas-analytics-frontend.git` |
| `git log --oneline -1` | backend | `d030515 gaps docs` |
| `git log --oneline -1` | frontend | `434dbb8 fix(ux): improve homepage navigation and product truthfulness` |
| `ls -la .env*` | both | only `.env.example` present; no `.env` files exist on this machine |
| `ls .github` | both | absent (no CI workflows) |
| `find src -name '*.js' \| wc -l` | backend | 322 source files |
| `find tests -name '*.test.js' \| wc -l` | backend | 67 test files |
| `grep -rhoE '^\s*(test\|it)\(' tests src --include='*.test.js' \| wc -l` | backend | 561 test declarations |
| `grep -rhoE '^\s*(test\|it)\(' src \| wc -l` | frontend | 239 test declarations (vitest reports 244 because some tests are generated in loops) |

## 2. Dependency installation

| Command | Repo | Result |
|---|---|---|
| `npm ci --no-audit --no-fund` | backend | exit 0. npm warned that install scripts for `msgpackr-extract` and others were not run under the current `allowScripts` policy; nothing failed. |
| `npm ci --no-audit --no-fund` | frontend | exit 0. Same class of warning for `esbuild@0.28.2` and `fsevents@2.3.3`; the build later succeeded, so the platform binaries resolved via optional packages. |

Only `node_modules/` (gitignored) was created. `package.json` and the lockfiles were not modified.

## 3. Backend checks

### `npm run ci:guards`

```
check-stubs: OK
check-routes: OK
check-models: OK
check-config: OK
check-readme-sync: OK
ci:guards OK
```

### `npm test`

The runner (`scripts/ci/run-tests.js`) forces `PASSWORD_KDF=scrypt`, `NODE_ENV=development`, `REDIS_URL=` (in-memory cache/queue), `STORAGE_PROVIDER=local`, a throwaway `MONGODB_URI`, rate limits of 10 000, and `MAIL_PROVIDER=none` with SMTP variables deleted. Integration tests boot `mongodb-memory-server`. No network service, real mailbox, payment provider or production resource is contacted.

```
ℹ tests 561
ℹ suites 3
ℹ pass 560
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 51232.133542

✖ failing tests:

test at tests/self-service-registration.integration.test.js:205:1
✖ concurrent registration for the same workspace URL has one winner (186.836417ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
    actual:   [ 201, 201 ]
    expected: [ 201, 409 ]
```

Interpretation: two simultaneous `POST /api/v1/auth/register` calls with the same `workspaceSlug` both returned 201. The application relies on the MongoDB unique index on `Tenant.slug` (`src/models/Tenant.js:49`) to turn the second insert into an `E11000` error that `auth.service.js:572` maps to 409. Mongoose builds that index asynchronously (`autoIndex` is on outside production, `src/config/database.js:30`) and `tests/helpers/mongo.js` does not await index creation, so the race between index build and the two inserts decides the outcome. This is recorded as TST-001 (flaky, environment-dependent test) and, more importantly, DB-001 (production never builds indexes at all).

The pipe-status capture in the wrapper script printed empty under zsh; the exit status is therefore inferred from the runner summary (`fail 1` ⇒ non-zero), not captured directly.

**Side effect, reverted.** The runner forces `STORAGE_PROVIDER=local` but does not override `STORAGE_BASE_DIR`, so report and compliance tests wrote five synthetic artefacts into the repository's gitignored `backend/uploads/storage/` (created 23:37 during this run; the folder previously held only `.gitkeep`). They were deleted after the run, returning `uploads/` to its original state. This is itself a test-isolation defect (`scripts/ci/run-tests.js:44` claims a temporary directory is used); see document 17.

### `npm audit --omit=dev`

See section 5.

## 4. Frontend checks

| Command | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | pass, no diagnostics |
| `npm run lint` (`eslint .`) | 0 errors, 9 warnings, all `react-refresh/only-export-components` in `src/components/ui/{badge,button,form,navigation-menu,sidebar,toggle}.tsx` and `src/lib/auth/session.tsx` |
| `npm test` (`vitest run`, jsdom) | 27 files: 25 passed, 2 failed. 244 tests: 242 passed, 2 failed. 2.69 s |
| `npm run build` (`vite build`, Nitro/Vercel preset) | pass; "✓ built in 267ms", generated `.vercel/output/nitro.json`. Non-fatal rolldown `MODULE_LEVEL_DIRECTIVE` warnings for `"use client"` in Radix packages |

Failing tests:

```
FAIL src/lib/security.test.ts > Security: tenant slug storage > storeTenantSlug writes to localStorage with saas.tenantSlug key
FAIL src/lib/auth/session.test.tsx > storeTenantSlug() > writes to localStorage
AssertionError: expected "setItem" to be called with arguments: [ 'saas.tenantSlug', ... ]  Number of calls: 0
```

Interpretation: on Node 26 a native `localStorage` global exists but is unavailable unless `--localstorage-file` is passed (`node -e "typeof localStorage"` prints `undefined` with an `ExperimentalWarning`). Inside the vitest jsdom environment the spy on `Storage.prototype.setItem` is never hit, consistent with the call throwing and `storeTenantSlug` swallowing the error (`frontend/src/lib/auth/session.tsx:32-38`). The 2026-10-16 discovery report recorded 244/244 passing on an earlier Node. Recorded as TST-001.

Build output is gitignored; `git status --short` was empty afterwards. The build wrote `.vercel/output/` (created 23:36), which was deleted after the run so the working tree matches its original state. `node_modules/` was left in place in both repositories because installing dependencies was part of the approved plan.

## 5. Dependency vulnerability reports (`npm audit --omit=dev`, read-only)

Results are recorded in `14-security-assessment.md` section "Dependencies". No `npm audit fix` was run.

## 6. Repository hygiene scan

The four committed files `final-results.txt`, `summary.txt`, `test-output.txt`, `test-all-output.txt` (each ≈ 811–814 KB, UTF-16 LE, TAP output from `npm test` runs dated 2026-10-12) were decoded with `iconv` and searched for credential patterns (`mongodb://user:pass@`, `JWT_SECRET=`, `ENCRYPTION_KEY=`, `RAZORPAY_KEY_SECRET=`, `MAIL_PASSWORD=`, bearer tokens, `sak_` API keys). **Zero hits.** They remain tracked in git (`git ls-files` lists all four). Recorded as SEC-001 (hygiene).

`git ls-files | grep -iE '\.env|\.pem|\.key|credential|secret'` returned only `.env.example`.

## 7. Static analysis performed by reading

All other findings come from reading source (`Read`/`sed`/`grep`), not from executing the application. The application server was never started; no HTTP request was sent to any Analivo endpoint, local or remote.

## 8. Deliberately not executed

| Action | Why not |
|---|---|
| Requests to `https://analivo.vercel.app` or `https://saas-analytics-backend-ffao.onrender.com` | Brief forbids probing production; deployed-source parity is listed as a staging verification step in doc 20 |
| `npm run bootstrap:admin` | Creates/alters an administrator account |
| Any `npm audit fix`, `npm update`, dependency or lockfile change | Changes runtime configuration |
| Starting the server with real SMTP/Razorpay/S3/Redis configuration | Would send mail, create orders, or write to external storage |
| `npm run test:argon2` | Requires the native `argon2` binary; scrypt run already exercises the suite, and the KDF seam is covered by `tests/utils/password.test.js` |
| Browser end-to-end runs (Playwright or similar) | No E2E harness exists in either repo; adding one is a change |
| MongoDB connector against a live external database | Needs credentials and a sandbox host; listed as a staging test in doc 20 |
| Git commits, pushes, branches | Brief forbids |
