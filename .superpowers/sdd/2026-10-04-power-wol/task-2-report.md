# Task 2 report: owned power operations and bounded recovery

Status: implemented and automatically verified; hardware verification remains Task 5. Ready for independent compliance and quality review over `fd54bbb..HEAD`.

## Scope and producer evidence

Read the task-specific brief, approved design, ledger rulings and applicable engineering rules. Used TDD and verification-before-completion. Graft query did not locate the service reliably; inspected the current service and actual adapter/UDP producers directly. No whole implementation plan was read, and no agents or helpers were spawned.

Existing producers: `Lgtv2Adapter.powerOff` calls `ssap://system/turnOff`; `wake` delegates to `sendWakeOnLan`. The UDP producer sends three magic packets per unique MAC at 100ms intervals and owns socket closure. Controller ruling preserves this burst: one accepted WOL operation means exactly one `adapter.wake` invocation, not one datagram. Callback/send failure stops the burst; there is no new WOL or SSAP retry after ambiguous delivery.

## Implementation and affected contracts

- `apps/api/src/tv/service.ts`: sole owner of adapter, connection, probe, command, power and reconnect lifecycle. Added synchronous power admission, `powerState`, `setMac`, `startPower`, owner-checked `cancelPower`, and `cancelOwnedPower`. The common gate blocks conflicting power, command, probe, settings and connection work. A terminal display state does not release unfinished transport or cleanup ownership.
- `start(input, owner?)` retains the old setup operation response and optionally carries an opaque internal session owner. Task 3 must pass that owner for manual reconnect and wire revocation to `cancelOwnedPower`. Automatic recovery uses a distinct private server symbol. Owner values do not enter public projections or logs. Legacy `cancel(id)` rejects power operations so the old API cannot bypass owner checks.
- `apps/api/src/tv/recovery.ts`: scheduling and error classification only, no adapter/state owner. Immediate first attempt; cooldowns 1000, 2000, 4000, then 8000ms; each attempt receives `min(5000, remaining)`; deadline uses injected monotonic time and never extends. Only known network/lost-connection/pairing-timeout failures retry. Authorization, compatibility, key-storage and cleanup failures terminate. Timeout retains its preceding transient cause internally and publishes safe `RECOVERY_TIMEOUT`.
- Wake sends once, awaits transport-owned closure, then uses the same connection path as manual reconnect and automatic recovery. Ordinary loss observed by a status probe starts one server-owned cycle without WOL; exhausted cycles are not restarted by polling. Initialization uses saved-key reconnect without WOL, command replay or resuming historical operations.
- Power-off shares a 5000ms send/observation budget. First probe is immediate after ACK, then sequential probes have a 1000ms cooldown, per controller ruling. `succeeded` means command delivery plus observed connection unavailability, never proof of physical power state. Available-at-deadline is `POWER_OFF_UNCONFIRMED`; unacknowledged/ambiguous send is `unknown`. Sent or unknown off suppresses automatic recovery until explicit connection work. Authorization/compatibility observation errors are failures. Once unavailability was observed within budget, slow successful cleanup keeps the result succeeded and the admission gate busy; failed cleanup changes it to visible failure and fails closed.
- `packages/webos/src/adapter.ts`, `errors.ts`, `lgtv2-adapter.ts`, `wake-on-lan.ts`: added existing power methods to the adapter interface and `TvPowerSendError` transport provenance (`not_sent` or `unknown`). SSAP ownership remains pending until the raw request settles; UDP provenance is set at `socket.send`, with preparation failures proven `not_sent`. Synchronous throws from an asynchronous bind/send callback are caught at that owner and close the socket. Error causes, aggregate cleanup causes, established WOL burst and existing CLI success/exit behavior remain covered. The adapter remaps the original UDP cause using its existing error mapping.
- `apps/api/src/config.ts`, `runtime.ts`: `REMOTE_WEBOS_RECOVERY_TIMEOUT_MS`, default 60000, strict integer 1000..300000; invalid supplied values fail configuration. Existing pair/repair/change-address budgets remain 60000ms. The optional typed config field preserves callers that construct config directly.
- Test changes: new power/recovery suites; controlled fake power methods; narrow updates to lifecycle/runtime expectations for intentional bounded recovery. No routes, browser UI, authentication, database schema, dependencies or repository business rules changed in Task 2.

## RED / GREEN evidence

All commands ran in the existing isolated checkout. Loopback-containing suites used approved escalation; no EPERM workaround was applied. No real-TV commands or permanent TV data were accessed.

1. `pnpm --filter @remote-webos-tv/api exec vitest run test/tv-power.test.ts test/tv-recovery.test.ts test/tv-lifecycle.test.ts test/config.test.ts`:
   RED exit 1, 23 failed / 43 passed. Failures named missing service power methods, missing config validation, 60000 vs 5000 attempt budget and missing monotonic recovery. Existing lifecycle 24/24 passed before implementation. Initial GREEN had 64/66 with two old expectations that assumed no automatic recovery; updated only those intended transitions. Later GREEN 68/68.
2. `pnpm --filter @remote-webos-tv/webos exec vitest run test/lgtv2-adapter.test.ts test/wake-on-lan.test.ts -t 'power delivery|power request cancellation|UDP bind rejection'`:
   RED missing provenance and raw request ownership; after correcting a fake-client capture error, reran raw ownership RED (settled too early). GREEN 3/3.
3. `pnpm --filter @remote-webos-tv/api exec vitest run test/config.test.ts`: GREEN 26/26 after recovery config implementation.
4. Owner/legacy cancellation focused run with `-t 'legacy cancellation|opaque owner'`: RED 2/2, GREEN in the subsequent 68-test run. A test awaiting unrelated revocation before its claimed pre-worker cancellation was corrected to maintain the intended synchronization boundary.
5. Power focused `-t 'pre-send wake failure'`: RED the never-connected wake adapter remained open; GREEN after cleanup and no automatic recovery from that adapter. Power/recovery/lifecycle/config then 72/72 and typecheck exit 0.
6. UDP focused `-t 'empty and invalid|asynchronous bind'`: RED 2/2 (empty input lost provenance; async callback throw escaped the resource owner). GREEN UDP suite 9/9.
7. Self-review focused `-t 'observed off unavailability|retains the original'`: RED 2/2 (slow cleanup overwrote succeeded; recovery deadline discarded transient cause). GREEN power/recovery/lifecycle/config 74/74, typecheck and diff check exit 0.
8. Self-review focused `-t 'off cancelled before|off cleanup failure'`: RED 1/2 (pre-worker cancellation invalidated live capability), cleanup failure already passed. GREEN after preserving the verified no-send connection: power15 + recovery11 + lifecycle24 + config26 = 76/76, typecheck and diff check exit 0.

## Final verification

- Full `pnpm test`: exit 0, 740/740 at the pre-final self-review checkpoint: contracts231, webos109, web103, API237, protocol-probe60. This verifies the old CLI paths and the complete repository suite. Four later regression tests and their small lifecycle fixes were followed by the complete affected suites below; unaffected suites were not redundantly repeated.
- Final `pnpm --filter @remote-webos-tv/api exec vitest run --silent`: exit 0, 22 files, 241/241, after all lifecycle changes. Startup error, runtime, repository, existing authenticated command routes and all ten commands pass.
- Final `pnpm --filter @remote-webos-tv/webos exec vitest run`: exit 0, 9 files, 109/109, including the existing CLI/probe adapter paths and three-packet WOL assertion.
- Final `pnpm typecheck`: exit 0 across all five workspace packages after the last functional change.
- `git diff --check`: exit 0 after final functional and local indentation changes.

The first full run failed because process-based API startup tests imported stale compiled webos output without the new exported class, plus an old runtime test expected one-shot reconnect failure. The dependency output was refreshed and that runtime expectation now asserts the deliberate `connecting`/running reconnect. Subsequent full and affected-suite executions passed; these initial failures were not hidden.

## Operational incident and limitations

I incorrectly used `pnpm --filter '@remote-webos-tv/api...' build` when refreshing compiled dependencies. API's dependency graph includes the web package, so the command also rebuilt web assets despite the explicit no-web-build instruction. The controller confirmed the live HTML referenced the new hashed asset while the already-running server's static allowlist returned 404 for it. I reported the mistake immediately; the controller handled the user-facing recovery decision separately. I did not restart the live server or inspect/mutate permanent application data. Subsequent explicit webos build and test commands did not invoke another web build. This incident is a process concern even though the source change suites pass.

Self-review checked transport send counts, bounded deadlines, no automatic pairing prompts/WOL/command replay, old setup response shape, MAC/key preservation, owner isolation, legacy cancellation, late responses, cleanup barriers, public error redaction and narrow source scope. No known failing tests remain. Session logout/API power security wiring and browser display remain Tasks 3–4; real LAN broadcast, wake, actual standby state and physical display remain unverified until separately authorized hardware validation. A deliberately non-settling dependency keeps admission blocked and shutdown waiting, as required, rather than silently freeing ownership.

The commit uses explicit task product/test/report paths and excludes untracked `graft/` and controller-owned planning documents. Independent review remains required before task acceptance.
