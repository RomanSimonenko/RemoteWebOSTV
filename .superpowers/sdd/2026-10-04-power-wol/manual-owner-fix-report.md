# Manual power-off connection owner fix

Date: 2026-10-04. Base: `a541e61`, branch `codex/power-wol`.

## Observable failure and owning cause

The controller's scoped brief records a real acceptance observation: one confirmed browser power-off physically switched the TV off, while the server eventually published `failed / POWER_OFF_UNCONFIRMED / sent`. The browser then could not offer wake because the canonical connection remained `available` indefinitely. This task did not repeat that hardware action or access permanent application data.

The automatic reproduction uses the existing `ControlledAdapter`, `ControlledScheduler`, and cleanup barriers. Its power-off is acknowledged, its observation snapshots remain available, and its five-second deadline expires. The existing test had asserted `available` after local disposal, embodying the stale owner state.

Root cause: `disconnect` in `apps/api/src/tv/service.ts` detached `activeAdapter` and `remoteCapability` without changing `connection`. `runPower` intentionally preserves the connection classification for unconfirmed off and cancellation, then disposes the adapter after transport ownership settles. `status` only probes an active adapter; absent that adapter, it could never correct the stale availability. `powerState` and `assertCanStartPower` correctly require unavailable connection for wake, so their consumers could not repair it.

All callers were inspected before changing the canonical owner: ordinary operation replacement/retry/failure (`run`), manual off/wake (`runPower`), failed status probing (`readStatus`), and service shutdown (`close`). Admission, terminal publication, and cleanup ownership paths were read together.

## Small production change and state contract

Only the canonical `disconnect` changes production behavior. When the adapter being disposed is the current `activeAdapter`, it detaches the adapter/capabilities and changes `available` to `unavailable`. The transition is synchronous when ownership is removed, before asynchronous transport cleanup settles.

- `unavailable` means the application's connection is unavailable. It does not establish physical TV power state.
- A failed `POWER_OFF_UNCONFIRMED` remains failed with `sent` or `unknown` delivery. Late send completion cannot publish success or change certainty.
- `connecting`, `pairing`, `authorization_error`, and `compatibility_error` retain their existing classifications. Disposal of an adapter that is not currently owned cannot rewrite the current connection.
- Cleanup remains owned and blocks all competing admission. Wake becomes available only after cleanup/work settle successfully and a saved MAC exists; cleanup failure remains fail-closed with the original safe diagnostic enriched by `_CLEANUP_FAILED`.
- Pre-worker off cancellation sends nothing, disposes nothing, and retains the verified available connection and capabilities.
- Intentional-off recovery suppression, one explicit WOL operation, no command replay, authentication, UUID receipts, throttling, routes, timeout budgets, public schemas, persistence, and UI policy stay under their existing mechanisms.

The affected public observation is the connection state after local disposal, including shutdown or sent/ambiguous off cancellation if they detach an available owned adapter. Wake admission subsequently uses that corrected state and the existing common gate. No unconditional UI enablement, route bypass, automatic wake, automatic retry/recovery, or physical-off success claim was introduced.

## Changed files

1. `apps/api/src/tv/service.ts`: owner-level available-to-unavailable transition on current-adapter disposal; explanatory power-state comment.
2. `apps/api/test/tv-power.test.ts`: replaces the stale unconfirmed-availability expectation; covers pending cleanup, failed cleanup, retained terminal diagnostics/certainty, explicit next wake once, no automatic work from repeated reads, pre-dispatch cancellation, and authorization/compatibility preservation.
3. `apps/api/test/tv-lifecycle.test.ts`: extends the existing held replacement-cleanup test with literal pairing/connecting cases, retaining timeout/cleanup-gate checks.
4. This report. Unrelated `graft/` remains untouched and excluded from the commit.

## RED and GREEN evidence

The test change preceded the production patch. The break named in advance was availability remaining true after the current connection is detached; an unconditional disposal classification would additionally break the authorization/compatibility and replacement-phase protections.

`pnpm --filter @remote-webos-tv/api exec vitest run test/tv-power.test.ts`:

- RED, 16:27:11: exit 1, 3 failed / 16 passed. Each failure was `expected 'available' to be 'unavailable'`, in unconfirmed off with held cleanup, unconfirmed off with failed cleanup, and no-ACK timeout after late transport settlement. No production code had been changed.
- GREEN, 16:27:25 after the owner patch: exit 0, 19/19.
- Final focused power/lifecycle run at 16:28:37: `pnpm --filter @remote-webos-tv/api exec vitest run test/tv-power.test.ts test/tv-lifecycle.test.ts`, exit 0, 44/44 (power 19, lifecycle 25).

The deterministic tests verify cooldown at 999 + 1 milliseconds, expiry at 5,000 milliseconds, late transport/cleanup settlement, and a subsequent controlled 60-second advance. They use barriers and the injected scheduler, with no natural timing sleeps. Assertions read the real service's public state/admission and external adapter effects, using synthetic fixture values. Failed-cleanup tests assert shutdown failure explicitly and release held barriers in teardown.

## Verification commands and results

In the implementation worktree:

- Affected API command: `pnpm --filter @remote-webos-tv/api exec vitest run test/tv-power.test.ts test/tv-power-routes.test.ts test/tv-service.test.ts test/tv-recovery.test.ts test/tv-lifecycle.test.ts test/tv-runtime.test.ts test/tv-commands.test.ts test/tv-command-routes.test.ts`. Approved loopback execution, exit 0, 8 files / 146 tests. This was before adding the second replacement-phase case; the final full suite includes that additional test.
- `pnpm typecheck`: exit 0 across all five packages, repeated after the final test-source changes.
- `git diff --check`: exit 0 after final source changes and during self-review.

Builds, full workspace tests with build hooks, and browser tests ran only in the existing temporary staging directory `remote-webos-power-e2e.4wROKU`. No original worktree dist assets were built. The staging copy was synchronized first with the tracked `apps`, `packages`, root package/lock/workspace files, and base TypeScript configuration. Dependency copies and their relative links were reused, with `pnpm_config_verify_deps_before_run=false` to avoid an automatic install.

Source identity before staging verification:

- Aggregate SHA-256 of the ordered tracked file SHA-256 listing was identical in worktree and staging: `224e702000819564b73fe5af1f78b3fcc94a5d677bf7aa1e03822078ef9125b9`.
- `apps/api/src/tv/service.ts`: `8c3729e819a881dd173bf8c50c641d0ebf77e8a4c72391e55f5202aeb5b9e023`.
- `apps/api/test/tv-power.test.ts`: `e0db82367554ea6371c79a82b241f00d05320a488a10eec709ad48452a2db5a4`.
- `apps/api/test/tv-lifecycle.test.ts`: `4416329066765d9b1ab58a261c0a83817c27ca621064239c68886cc6133ec079`.

In synchronized staging:

- `pnpm_config_verify_deps_before_run=false pnpm build`: exit 0, all five workspace builds, including staged web/API assets.
- `pnpm_config_verify_deps_before_run=false pnpm test`: fresh final-source run once, exit 0, 815/815: contracts 231, webOS 115, web 140, API 269, protocol probe 60. The protocol-probe pretest build hook executed inside staging only. Synthetic HTTP, mock-TV, UDP-loopback, session ownership, recovery, and cleanup paths passed.
- `pnpm_config_verify_deps_before_run=false pnpm --filter @remote-webos-tv/web exec playwright test`: exit 0, 23/23 across authentication, pairing/restart, all seven power scenarios, browser preparation, and remote command behavior (1.4 minutes). Only a benign inherited `NO_COLOR`/`FORCE_COLOR` warning was emitted. All API/runtime/mock-TV instances used temporary fixture data and loopback routing.

## Failed initial invocation and environment limits

The first intended narrow command was incorrectly written as `pnpm --filter @remote-webos-tv/api test -- test/tv-power.test.ts`. The forwarded `--` made Vitest run the whole API suite. It exited 1 with 12 failed / 256 passed: the three intended RED regressions plus nine environment failures due to sandbox loopback restrictions. Those nine were:

- `logging`: startup log does not expose the listening address.
- `runtime`: failed HTTP listen closes runtime/removes handlers; SIGINT shutdown; SIGTERM shutdown; failed signal shutdown safe diagnostics (the last raised an aggregate startup/cleanup error).
- `tv-command-routes`: real HTTP body completion and disconnect during admission.
- `tv-service`: all ten real-adapter mock-TV commands; saved registration after restart without PROMPT; identity failure never commits SQLite.

Eight reported direct `listen EPERM`; the runtime aggregate also arose from denied listen. The corrected direct `exec vitest run` produced the isolated three expected RED failures. Approved loopback affected checks and the final full staging suite passed all those tests. No production workaround for sandbox behavior was added.

Existing staging bootstrap caveat remains: this task reused the previously prepared dependencies and did not prove a fresh checkout's initial install/build/bootstrap path. Browser tests exercise a synthetic API/runtime and mock TV; neither their success nor this corrected application connection state proves hardware wake or physical off.

## Self-review and residual risk

Reviewed each disconnect caller and every power terminal/cleanup return path against the binding spec and scoped brief. The patch lives at the owning service boundary, with one condition and no duplicated policy, dependencies, environment values, hidden fallback, error masking, auth changes, persistence changes, or transport sends. Source identifiers and tests are synthetic; no permanent data, live endpoints, physical TV actions, credentials, push, or PR were used.

Mental falsification: removing the new transition fails three RED-derived assertions; making it unconditional fails exact authorization/compatibility and pairing/connecting protection; releasing the gate early fails held-cleanup admission; clearing unsafe cleanup fails explicit rejected wake/shutdown; starting recovery from reads or repeating off/WOL fails the adapter/read/send counts. The full final suite checks sibling cleanup, command, route, and recovery consumers.

Implemented and automatically verified. Independent review, deployment, and the repeated real-TV browser off/wake/reconnect acceptance remain controller-owned and have not been performed by this task.
