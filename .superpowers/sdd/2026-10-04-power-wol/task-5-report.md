# Task 5 — automated integration and documentation

BASE: `490016f03d486283dc54196a5750230fe6099087`. Tasks 1–4 accepted before this work. Scope: built browser path and documentation; no production change or redesign. Hardware/live acceptance belongs to the controller and remains pending. User authorized that later phase after automatic checks; no missing-permission blocker is claimed here.

## Implementation

- `apps/web/test/e2e/tv-power.spec.ts`: seven real built UI/auth/API/SQLite/adapter scenarios. Cancel confirmation produces no operation or SSAP; confirmed turnOff has exactly one request and no payload, observes transport loss while explicitly disclaiming physical proof, and suppresses recovery. MAC invalid/zero rejects, dash input normalizes, restart preserves selected value and intentional null, absent MAC gives WOL_NOT_CONFIGURED without a wake. Browser double click produces one POST; stale second tab conflicts without another wake; reload preserves operation id; unavailable attempt followed by clock-driven retry registers using saved key without PROMPT. Automatic recovery has no WOL or user cancellation and leaves the legacy operation null; timeout empties timers and later status/reload do not restart it. Lost genuine accepted POST response shows uncertainty; reconnect/reload/logout-login never replay powerOff. Another session cancel returns403 and its logout cannot abort the owner's wake; initiating logout aborts transport and releases timers/sockets.
- `apps/web/test/support/tv-fixture.ts`: test-only external WOL dependency records adapter calls and supports an abort-aware gate, avoiding actual broadcast. Existing real API/security/SQLite/adapter remain in use. Scheduler exposes pending timers/next deadline for deterministic synchronization. UUID generator now mirrors real production randomUUID's wire contract, using deterministic synthetic values. `expireUnavailableRecovery` observes canonical status, waits for first cooldown, advances the60s deadline, and verifies RECOVERY_TIMEOUT/timers0.
- Existing `tv-remote.spec.ts` two offline scenarios and `tv-pairing.spec.ts` one unavailable/address-change scenario now wait for bounded recovery expiry. Earlier immediate offline assumptions preceded the authorized recovery behavior; no production workaround is introduced. Address-change diagnostic selector is precise because the power panel may separately retain its timeout alert. Existing synthetic `tv-remote-preparation.spec.ts` now supplies the real power-state shape for GET/api/tv/power; this preserves its intentionally isolated browser-preparation scope and is not full-path API proof.
- `packages/webos/test/wake-on-lan.integration.test.ts`: real UDP sender/loopback receiver, independent literal102-byte packet/header/16 MAC repetitions, three packets, sender close. Destination replacement is test-only; bind/send callbacks/close are actual dgram operations.
- README, new `.env.example`, hardware compatibility report, MVP roadmap and power plan describe current behavior, timeout config1000..300000/default60000, sequential attempt budget5s and cooldowns1/2/4/8s, same-LAN server/agent requirement, one adapter wake/three-packet burst, no replay, MAC privacy/backup, receipt cap100/session with new login needed for new UUIDs, and hardware pending. PR#4 already merged into main.

## Isolation and preliminary execution evidence

All builds/tests ran in temporary staging basename `remote-webos-power-e2e.4wROKU`. Created with mktemp; tracked BASE git archive extracted, root and each workspace node_modules copied with cp-R preserving relative symlinks. No absolute node_modules symlinks found. Source and dist are independent copies, not hardlinks. No .git, permanent .local data, graft or worktree dist copied. Source edits use apply_patch in original worktree, then explicit source copies to staging.

1. Initial `pnpm build` stopped before scripts because pnpm11 detects copied workspace fingerprint and attempts automatic install, refused at NO_TTY; metadata fetch also failed. Inspected installed pnpm implementation and used scoped `pnpm_config_verify_deps_before_run=false` for staging commands only. No install/upgrade or package/config source change.
2. First isolated recursive build then exposed pre-existing fresh checkout bootstrap cycle: web test fixture imports built API/webOS, while build graph runs web before API. Contracts/webOS compiled; web typecheck reported missing API dist (and early webOS dist). Explicit staging-only API build followed by web build passed. Final recursive build will run after bootstrap. This startup build gap is not fixed by Task5.
3. Sandbox UDP bind EPERM and Chromium bootstrap/MachPort Permission denied prevented all tests before application exercise. Scoped escalation enables only local synthetic test sockets/Chromium. UDP integration passed1/1,206ms.
4. First permitted focused power run:3passed/4failed41.4s. Three failures were automatic recover GET500 from fixture's former opaque browser-operation ids instead of UUID. Fourth was API read before login HTTP completion. Corrected fixture UUID producer and synchronized login on authenticated TV heading. Second focused run passed7/7,36.5s.
5. Negative control: changed only staging compiled adapter's powerOff URI to ssap://system/turnOffBroken. One focused confirmation test failed as intended, expected succeeded vs actual failed,8.1s. Restored artifact exactly; before/after SHA256 `e6f516084a025e88e86af52e8b95500b32baf633b926dadca4e8149fe5a40d45`. Original source was never mutated. This proves the browser path observes real adapter dispatch.
6. Legacy risk subset first run0/3 (individual test durations8.3s,9.9s,30.0s): immediate unavailable expectation, offline panel while busy, disabled reconnect during recovery. Clock-driven expiry change yielded2/3,20.3s; remaining failure was ambiguous global alert selector. Precise diagnostic selector single retest passed1/1,7.7s. No rerun-until-green policy: each rerun followed a named fixture/expectation correction; no production failure or flaky retry.

## Final source and fresh broad evidence

Checkpoint `7eeba366e2341a8c258056c0e17936837bcb1e7a` committed all ten initial Task5 paths. Original/staging complete tracked-file SHA256 manifests matched before full evidence: `fa00e142e1201ed8cca7f0cc638575e054f4945fba3051a86bfc23894eaa93e4`. Manifest procedure: git ls-files -z, xargs -0 shasum -a256 on each relative path, then shasum -a256 over those lines; staged files use the same tracked path inventory.

| Check | Snapshot/session | Result |
| --- | --- | --- |
| env pnpm_config_verify_deps_before_run=false pnpm test |7eeba36/session97539|exit0;810/810 in49files: contracts231/5, webOS112/10, web140/7, API267/23, probe60/4 |
| env pnpm_config_verify_deps_before_run=false pnpm typecheck |7eeba36/session63128|exit0, all five workspace projects |
| env pnpm_config_verify_deps_before_run=false pnpm build |7eeba36/session52114|exit0, all five packages, Vite111modules |
| env -u NO_COLOR pnpm_config_verify_deps_before_run=false pnpm --filter @remote-webos-tv/web test:e2e |7eeba36/session29436|exit1,20passed/3failed,1.5m; all actual API/TV paths passed; synthetic preparation fixture lacked GET/api/tv/power and tried to read dist/api/tv/power, ENOENT |
| Same E2E command with tv-remote-preparation.spec.ts |corrected fixture/session29588|3/3pass,1.3s after one-line test-only producer-shape response; original assertions retained |
| env pnpm_config_verify_deps_before_run=false pnpm typecheck |0e7b435/session59762|exit0, all five projects |
| env pnpm_config_verify_deps_before_run=false pnpm build |0e7b435/session10762|exit0, all five packages, Vite111modules |
| env -u NO_COLOR pnpm_config_verify_deps_before_run=false pnpm --filter @remote-webos-tv/web test:e2e |0e7b435/session95498|exit0,23/23pass,1.5m; seven power scenarios and all16prior checks |

Fixture correction and public bootstrap limitation saved in `0e7b4359615023593901dbd2fbc6dae5c17539ae`, then extracted over staging. Original/staging complete tracked manifest again matched: `ef9eada3faf9adbc062007a160ec130a7626bed48eea693a8e8156eb4944326d`. Only README and excluded E2E fixture differ from7eeba36; production and unit/integration source is identical. Therefore810-test evidence is explicitly at7eeba36, not falsely described as a new run at0e7b435. Fresh typecheck/build and full Chromium cover the later fixture correction. No repeated full Vitest run needed for an excluded E2E-only change.

Final full Chromium at0e7b435 session95498 passed23/23,1.5m, exit0. No successful run has been silently substituted for any failure. Playwright configured retries0 throughout; no retry-until-green loops and no observed flaky test. Build outputs remain wholly in staging. API suite emits normal safe JSON INFO request logs; first unrestricted pnpm preflight emitted metadata/update/NO_TTY diagnostics. No warning appeared in subsequent build/typecheck/Chromium output; full-test output is summarized by exit0 and per-project counts (tool output truncated routine logs), not a claim that every log line was retained. Documentation-only evidence additions follow; no executable/test source changed after0e7b435.

Fresh original-worktree git diff --check passed after all executable changes and again before final evidence commit. A mistaken staging git diff attempt earlier printed Not a git repository (staging intentionally has no .git); it did not check source and was not counted as the required result. Original-worktree checks provide that result. Staging source manifest remains ef9eada3faf9adbc062007a160ec130a7626bed48eea693a8e8156eb4944326d after builds/tests. Temporary staging and its synthetic Playwright evidence are retained for controller handoff; no unrelated worktree or SDD material removed.

Final executable/test file hashes at0e7b435:

| Path | SHA256 |
| --- | --- |
|apps/web/test/support/tv-fixture.ts|ea525a5f6416707a43f71dd7d5981ee6e0e05d62e3bb88eab3d067bd3d1b273f|
|apps/web/test/e2e/tv-power.spec.ts|a9b227deb32f22f567e61ef197b6e0461152c1cae022939818362cba0d0389f4|
|apps/web/test/e2e/tv-remote.spec.ts|f7d47e90de78d2452f923da5bbf0c033703febc114022bcd2c38a6680410f047|
|apps/web/test/e2e/tv-pairing.spec.ts|13be7332a36815bee66fb2d6c125ed79181e97879f33c8592c26670241796f2b|
|apps/web/test/e2e/tv-remote-preparation.spec.ts|93ca186ec547675a8ec90499270a25e47017e1121c9319fdd5ee5b1f1465b62b|
|packages/webos/test/wake-on-lan.integration.test.ts|e5623b6dc5edff3435cc3f9f889cbdf25d8bfc401fd672fc32d956858b2c130a|

## Self-review and concerns

No production bypass environment or public mock flag; WOL injection stays below real adapter boundary. Auth/Origin/CSRF/SQLite paths remain real. Only synthetic TV/account/MAC identifiers appear. No permanent keys/database read, live server8080 interaction, real TV command, restart or worktree build occurred. Existing user graft and SDD evidence preserved. No external message/push/PR.

Transport delivery does not prove physical effect; loopback does not prove LAN broadcast. Real hardware/live update, account preservation, pairing/no new prompt and physical off/wake must be validated by controller/user separately. Whole-branch independent review is controller-owned. Existing clean checkout dist/typecheck bootstrapping gap remains a disclosed operational limitation.
