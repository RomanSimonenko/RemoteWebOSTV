# Task 3 report: protected power API and session revocation

Implementation is complete and automatically verified; independent controller review is pending. Base: `9422999`, branch: `codex/power-wol`.

## Owning boundaries and changes

- `apps/api/src/tv/power-routes.ts`: registers protected GET `/api/tv/power`, strict PUT `/api/tv/mac`, strict POST `/api/tv/power`, and empty-body POST `/api/tv/power/:id/cancel`. Uses the actual authenticated request context and inherited router-identity Origin/CSRF/no-store policy, including encoded aliases. Unsupported synchronous admission maps to 422; conflicts, offline state and missing MAC remain 409. Asynchronous accepted failures remain operation results after 202.
- `apps/api/src/tv/rate-limit.ts`: a separate sole-owner power bucket accepts five starts per 60000 ms across sessions and source addresses. Reuses the installed limiter's non-mutating `read` and accepted `incr`; rejected requests and duplicates do not spend the budget. Existing store TTL supplies Retry-After.
- `apps/api/src/app.ts`: registers the new routes and passes the actual session service/request context to existing TV routes.
- `apps/api/src/tv/routes.ts`: authenticated manual reconnect alone receives the initiating session owner. Existing pair/repair/change-address ownership is unchanged. Start rechecks authentication and service admission after limiter yielding; preClose drains admission before runtime storage teardown. Legacy cancellation still cannot cancel power.
- `apps/api/src/auth/sessions.ts`: internal `revoke(token)` now returns `Promise<void>`, and `onRevoke` listeners may return a cleanup promise. Database invalidation and listener invocation remain synchronous, so command abort still happens immediately. Every listener runs despite a previous synchronous throw or rejection. Concurrent revocations join the same cleanup, all cleanup results settle, and failures preserve their causes (AggregateError when multiple).
- `apps/api/src/auth/routes.ts`: logout clears the cookie before awaiting revocation cleanup. Cleanup failure produces the existing safe 500 envelope; identity stays revoked and cookie clearing is retained.
- `apps/api/src/tv/service.ts`: one producer-level correction discovered by Task 3: `beginPower` explicitly selects `id` and `action` rather than spreading the request into the public operation. `confirm:true` belongs to the off request and previously broke the strict public operation schema, causing route 500. Wake/recover behavior and operation fields are preserved.

## Receipts, cancellation and lifecycle

Acceptance receipts are in memory, scoped to the authenticated initiating session, and capped at 100 accepted IDs. Capacity exhaustion returns 409 `POWER_RECEIPT_CAPACITY`; no accepted receipt is evicted. Same session + accepted ID + same strict payload returns the same operation without a new service start or rate charge. Reusing an accepted ID for another action returns 409. Strict validation fixes `confirm` to true for off, so action identifies every possible valid payload difference for a given ID.

Acceptance is recorded synchronously before the asynchronous accepted charge: a failed/lost response cannot authorize a second send for that ID. A completed receipt is refreshed before another operation is accepted and before legacy status polling can replace it with automatic recovery. Identical UUIDs used by different sessions retain separate receipts. UUID possession does not authorize cancellation: foreign/unknown receipts return 403, and a running receipt is additionally checked by the service owner boundary. A completed older receipt can be read/cancelled idempotently without affecting a newer operation.

Revocation removes that session's receipts and awaits `cancelOwnedPower` for its accepted power or authenticated manual reconnect. Another session's logout does not cancel it. Shutdown retains runtime ownership of transport work and disconnect cleanup, and drains held admission before SQLite closes. Request-response uncertainty never causes mutation retry or replay.

MAC PUT rechecks the authenticated session immediately before its synchronous service/storage mutation. Its schema accepts only `{mac:string|null}`, shares canonical normalization, preserves encrypted registration data, and uses the service's common busy gate.

Raw authenticated tokens exist only in the existing internal ephemeral request/ownership context; no public operation/state, diagnostic report, ordinary log, or committed fixture contains them. Tests use synthetic TV data and controlled UUIDs.

## Tests and RED/GREEN evidence

Created `apps/api/test/tv-power-routes.test.ts` (18 tests). Extended `apps/api/test/tv-runtime.test.ts` with three actual runtime tests and `apps/api/test/tv-power.test.ts` with the strict off producer regression. Updated the two real command-test direct revocation callers to await the new internal contract.

1. Initial route RED:
   - `pnpm --filter @remote-webos-tv/api exec vitest run test/tv-power-routes.test.ts`
   - Exit 1: 15 failures. Missing routes returned 404 instead of required authenticated/protected statuses. Authenticated legacy reconnect logout left `signal.aborted === false`.
   - Two limiter-race tests initially timed out because no route could reach the limiter. Their entry check was corrected before implementation.
   - `pnpm --filter @remote-webos-tv/api exec vitest run test/tv-power-routes.test.ts -t 'admission rechecks'`: exit 1, two proper RED failures (404 vs 200), no timeout.
2. First implementation route run: 10/15 passed; five off cases returned 500. Inspection traced the invalid object to `beginPower` spreading off `confirm:true` into the strict operation producer.
3. Strict producer RED:
   - `pnpm --filter @remote-webos-tv/api exec vitest run test/tv-power.test.ts -t 'strict public operation'`
   - Exit 1: one failure, strict parse returned false.
   - Minimal producer fix applied only to public operation construction.
   - Combined focused service/route run: exit 0, 17 selected tests passed (15 routes plus selected service checks).
4. Extended runtime/route checks:
   - `pnpm --filter @remote-webos-tv/api exec vitest run test/tv-power-routes.test.ts test/tv-runtime.test.ts`
   - Exit 0: 30 tests passed at that checkpoint (17 route + 13 runtime).
5. MAC revoke race RED/GREEN:
   - `pnpm --filter @remote-webos-tv/api exec vitest run test/tv-power-routes.test.ts -t 'MAC mutation rechecks'`
   - RED exit 1: revoked session still returned 200 and reached the mutation.
   - Added the immediate authenticated-session check in the MAC handler.
   - GREEN exit 0: one selected test passed, denied 401 with no repository writes.

New coverage exercises actual auth/Origin/CSRF/no-store paths, strict requests and missing confirmation, MAC normalization/clearing/key preservation, missing MAC/offline/unsupported distinctions, all control gates, same and foreign cancellation, concurrent UUID dedupe, payload conflict, owner rate budget/TTL/isolation, 100-receipt exhaustion, equal IDs in different sessions, logout/revoke with held transport and cleanup, manual reconnect logout, post-limiter revocation/lifecycle checks, asynchronous unknown delivery, lost acceptance response, all-listener failure aggregation and repeated cleanup, and MAC revocation between authentication and mutation.

Real runtime tests additionally prove shutdown waits for accepted power transport and disconnect before SQLite closes, held power admission is denied during shutdown without send/charge, and actual failed power cleanup leaves logout's identity revoked/cookie cleared while safe diagnostics propagate.

## Final verification

- Sandbox `pnpm --filter @remote-webos-tv/api test`: exit 1, 257 passed / 9 failed / 266 total. All nine failures were the existing sandbox loopback-listen boundary (`EPERM`), including one startup/cleanup aggregate triggered by that denial. Failures: `logging.test.ts` startup listening-address check; `runtime.test.ts` failed-listen cleanup, SIGINT, SIGTERM and failed-signal cleanup; `tv-command-routes.test.ts` real HTTP body/disconnect; `tv-service.test.ts` real-adapter ten buttons, restart registration and invalid identity persistence. All power-route/runtime additions passed.
- Same exact API suite with approved sandbox escalation for synthetic local mock listeners: exit 0, 23 files / 266 tests passed. Following removal of random test IDs, a final fresh run also passed 23 files / 266 tests (session 63259; exit 0).
- `pnpm typecheck`: final exit 0 across contracts, webOS, web, API and protocol-probe (session 26207). Typecheck does not build web assets.
- `git diff --check`: exit 0 before final staging.
- No package build, real-TV command, permanent-data mutation, live application restart, or live asset change was performed.

## Self-review and remaining boundaries

The service remains the sole connection/send/storage owner. API admission and accepted charge are serialized; work is not queued behind long-running transport. Authentication and the common service gate are checked again after asynchronous limiter boundaries. The MAC and cancel mutations retain inherited Origin/CSRF enforcement. The only existing operation that gains session ownership is manual reconnect.

Receipt and revocation maps have explicit cleanup; accepted IDs remain protected within their session until revocation or app shutdown. Rate limiting is independent of receipt eviction because accepted receipts are never evicted. Public errors preserve request IDs, safe cause types and no-store. Transport acknowledgement/UDP delivery is never promoted into proven physical power success.

No unresolved implementation blocker is known. Limits intentionally retained from the approved ruling/spec: 100 accepted operations require a new session for further IDs; receipts do not survive restart; automatic mutation retry remains forbidden. The existing observed-expiry authentication policy is unchanged; this task wires explicit revoke/logout. Real-TV power/WOL behavior and browser flow remain later validation obligations. The previously recorded live asset incident is outside this patch and still requires controller/user handling. Independent Task 3 review remains pending.

`graft/` was preserved untracked and excluded from the commit. Its graph was used for function location; current source and installed limiter producer behavior were authoritative.
