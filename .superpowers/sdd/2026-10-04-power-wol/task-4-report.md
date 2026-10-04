# Task 4 — browser power and WOL controls

Status: implemented and automatically verified; independent controller review pending.
Base: `e7ccd88`. Commit message: `feat: add browser power and WOL controls`.

## Scope and boundary evidence

Read the task-4 brief, binding power/WOL spec and SDD rulings. Located the owning React/API paths and inspected actual `power-routes.ts`, `service.ts`, strict shared contracts and existing Remote UUID/error lifecycle before implementation.

Actual producer details used:

- GET `/api/tv/power` and PUT `/api/tv/mac` return strict public power state. POST `/api/tv/power` returns HTTP 202 with the accepted operation, including client ID and action; cancellation returns HTTP 200 with the operation.
- Service `view()` deliberately serializes `operation: null` for power/automatic recovery; legacy manual reconnect retains the legacy operation. An early exploration assumption that power appeared as legacy reconnect was corrected against this producer before final integration. The initial synthetic sibling fixture was corrected too; this was a fixture/assumption correction, not a discovered product defect.
- Canonical service admission prevents remote commands and TV mutations while work/recovery is active. UI consumes server `power.operation.status` to disable setup and explicit reconnect, while Remote retains canonical `/tv/remote` admission. No client recovery machine or automatic reconnect/WOL/POST retry was introduced.
- Automatic `recover` is server-owned and has no initiating-session receipt: it displays status/deadline without a cancel control. User `wake`/`power_off` use the new cancellation route. Manual reconnect keeps its old cancel route.
- Pre-dispatch rejection proof is derived only from a validated error envelope, route and known HTTP status/code pair. Lost responses, malformed responses, mismatched IDs/actions and unexpected successful acceptance statuses stay uncertain.

## Changes

- `apps/web/src/pages/PowerControls.tsx`: inline controls beside saved TV, explicit power-off confirmation, accessible status/alert, MAC editing/normalization/clearing, WOL prerequisites and LAN/MAC warning, safe delivery/terminal copy, server deadline countdown and explicit user-operation cancellation. Countdown zero never completes or restarts the server operation locally.
- `apps/web/src/useTvPower.ts`: one runtime for polling and mutations; immediate synchronous pending gate prevents double activation; initial loading stays separate from background reads. GETs start at least two seconds after prior completion, never overlap, and manual refresh shares cooldown. Reads started before a mutation response cannot restore old operation/MAC; a subsequently started read is authoritative across tabs. 401 stops timers and aborts both request types; inactive/unmount/session-token replacement ignores late responses.
- `apps/web/src/api.ts`: strict power API consumers, accepted ID/action/status validation, cancellation ID/status validation, ApiFailure provenance for validated power rejection, actionable server admission/receipt-capacity errors. Existing command provenance is preserved.
- `apps/web/src/requestId.ts` and `pages/Remote.tsx`: narrow extraction of the existing cryptographic `getRandomValues` UUID mechanism, reused by both consumers on HTTP LAN origins; no randomUUID-only implementation.
- `apps/web/src/pages/TvSetup.tsx`: embeds controls and consumes their canonical power snapshot for sibling setup/reconnect availability. Manual setup/reconnect lifecycle remains unchanged.
- Tests: new `PowerControls.test.tsx`, `useTvPower.test.tsx`; real producer-shaped sibling coverage in `TvSetup.test.tsx`; new read fixture in `App.test.tsx` and shared Remote fixtures. Fixtures contain synthetic MACs/IDs only.

## RED / GREEN execution evidence

All commands below were executed in the isolated worktree, with synthetic fetch responses; no live browser or TV interaction.

1. `pnpm --filter @remote-webos-tv/web exec vitest run src/pages/PowerControls.test.tsx src/useTvPower.test.tsx`
   - Initial RED: 19 failed, zero passed. Missing controls and API methods were the expected missing-feature failures. The initial component was an empty scaffold, not an implementation.
2. `pnpm --filter @remote-webos-tv/web exec vitest run src/useTvPower.test.tsx`
   - Hook RED after API implementation: seven lifecycle/read failures, four API tests passed. Empty hook scaffold performed no reads/mutations; absence of signals also produced three dependent assertions' TypeErrors.
3. Focused GREEN after implementation: API/hook 11 passed; UI initially 11 passed/four failed because one reused Response instance was consumed by repeated polling. Fresh-response fixture correction produced 26/26 passed.
4. `pnpm --filter @remote-webos-tv/web exec vitest run src/pages/TvSetup.test.tsx -t 'recovery shares'`
   - Initial sibling RED: one failed, 19 filtered out. The initially incorrect legacy-projected fixture exposed the old cancel button; fixture later corrected to actual `operation: null` producer shape.
5. `pnpm --filter @remote-webos-tv/web exec vitest run src/pages/TvSetup.test.tsx -t 'server-owned'`
   - Real-shape automatic-recovery RED: one failed, 21 filtered out because the UI offered unauthorized new-route cancellation. Hiding cancellation for `recover` addressed this at its UI consumer.
6. `pnpm --filter @remote-webos-tv/web exec vitest run src/pages/PowerControls.test.tsx src/useTvPower.test.tsx src/pages/TvSetup.test.tsx`
   - Final focused GREEN: 56 passed in three files, exit 0.
7. Initial complete web suite: 121 passed, 19 Remote tests failed. Shared Remote fixture did not recognize the new GET power route and produced an extra alert. Added the full public power-state fixture to its known routes; no production fallback/alert suppression.

## Final checks (fresh)

`pnpm --filter @remote-webos-tv/web test` — exit 0:

```text
test/api-process.test.ts: 8 passed
src/useTvStatus.test.tsx: 7 passed
src/useTvPower.test.tsx: 14 passed
src/App.test.tsx: 10 passed
src/pages/PowerControls.test.tsx: 20 passed
src/pages/TvSetup.test.tsx: 22 passed
src/pages/Remote.test.tsx: 59 passed
Test Files 7 passed (7)
Tests 140 passed (140)
```

`pnpm typecheck` — exit 0, contracts/web/webos/API/protocol-probe all Done.
`git diff --check` — exit 0, no output.

An earlier narrow web typecheck caught insufficient null narrowing in the new start guard; explicit `!current.state` admission check resolved it. Both subsequent narrow and final workspace typechecks passed.

## Self-review and falsification

Verified no POST on confirmation cancellation, no double start while pending, cryptographic HTTP-LAN IDs, invalid MAC rejection, canonical normalized save and explicit clear, wake disabled without MAC, no Connected claim during sending, safe sent/unknown distinctions, separate timeout/key/compatibility/unsupported/off-unconfirmed diagnostics, restored operation/deadline on reload, no automatic POST replay after transport/malformed/identity failure, countdown remaining running at zero, and no physical-off claim from unavailable connection alone.

Deterministic barriers/fake clocks prove completion cooldown/no overlap, background loading stability, stale cancel/MAC read fencing, fresh other-tab replacement, lost-read admission clearing, inactive/unmount/new-token aborts, live 401 stopping both concurrent request types, ignored late responses and no storage/logging of MAC/secret-bearing payloads. Existing 59 Remote tests cover generator extraction and command behavior. Sibling fixtures use actual null power projection; automatic recovery cannot show an unauthorized cancellation, and manual reconnect still cancels through its owning legacy route.

Diff reviewed for unrelated edits, duplicated UUID implementation, client recovery logic, secret/browser persistence, machine configuration hardcoding, error masking and POST retries. No such additions found. `graft/` remains untouched and untracked.

## Concerns / verification limits

- No known implementation blocker from the self-review. Independent controller review still required.
- GET power does not expose user-operation ownership; a different session may see a user wake/off operation but receives the server's protected rejection if it tries to cancel it. UI makes no guess about session ownership from opaque IDs. Automatic recovery has an explicit server-owned action and therefore no cancel control.
- No web/package builds, E2E, actual browser interaction, real-TV command, server restart or permanent-data access occurred. Task 5 must verify built browser/full route integration in its isolated synthetic environment; hardware acceptance remains separate.
- The earlier live static-asset 404 incident and restoration decision remain unchanged/pending outside Task 4. This task did not rebuild assets or attempt restoration.
