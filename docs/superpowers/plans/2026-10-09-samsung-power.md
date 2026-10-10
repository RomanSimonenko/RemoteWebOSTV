# Samsung Power Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Управлять питанием Samsung без MAC, с одной безопасно допущенной командой и проверкой фактического состояния.

**Architecture:** Samsung-адаптер владеет свежим HTTP-наблюдением и guarded toggle; сервис — операцией, дедлайном, наблюдением результата и сохранёнными credentials. Питание отделено от состояния соединения. LG продолжает использовать существующие методы и WOL.

**Tech Stack:** TypeScript, Node.js, ws, Zod, React, Vitest, Playwright; без новых зависимостей.

**Spec:** `docs/superpowers/specs/2026-10-09-samsung-power-design.md`

## Global Constraints

- Только точные HTTP `device.PowerState` значения `on` и `standby`; всё остальное — `unknown` либо конкретная ошибка чтения.
- Один `KEY_POWER`, никаких автоматических повторов, WOL fallback и `KEY_POWEROFF` для Samsung.
- Читать HTTP до открытия WSS и непосредственно перед отправкой: handshake может включить ТВ.
- Соединение не подменяет питание; `standby` не означает `connection: unavailable`.
- Сохранить API маршруты, receipts, авторизацию, отмену, cleanup gate и LG-поведение.
- Samsung-настройки питания убрать полностью; поле IP не менять. Подтверждение выключения — минималистичный существующий popup.
- Не выполнять физические команды без отдельного согласования; не публиковать credentials или идентификаторы устройства.
- Реализацию начать в изолированном checkout от актуального `origin/main`; сохранить несвязанные изменения и `graft/`. Коммиты, Docker rollout и GitHub — после соответствующего запроса пользователя.

## Review Focus

- Внешний пульт меняет состояние во время handshake: повторное чтение исключает лишний toggle (Task 1).
- WSS остаётся открыт в standby: успешное выключение не требует разрыва соединения (Task 2).
- Запись имеет неизвестный результат: наблюдение продолжается без повторной отправки (Tasks 1–2).
- Поздний HTTP-ответ после отмены или смены TV не переписывает результат/новую сессию (Task 2).
- Samsung standby без MAC остаётся включаемым; LG без MAC не получает ложного разрешения (Tasks 2–3).

---

### Task 1: Samsung guarded toggle and adapter contract

**Files:**
- Modify: `packages/tv-adapter/src/index.ts`
- Modify: `packages/tizen/src/response-parsers.ts`, `packages/tizen/src/samsung-adapter.ts`
- Test: `packages/tizen/test/samsung-adapter.test.ts`, `packages/tizen/test/support/mock-samsung.ts`

**Interfaces:**
- Produces: `TvObservedPower = 'on' | 'standby' | 'unknown'`; optional `readPowerState(signal: AbortSignal): Promise<TvObservedPower>`.
- Produces: optional `setPowerState(desired: 'on' | 'standby', request: PairingRequest): Promise<TvPowerSetResult>`.
- `TvPowerSetResult = { readonly delivery: 'not_sent' | 'sent'; readonly pairing?: PairingResult }`. `pairing` returns new handshake data for the service to persist, not a credential in public state.
- Parser: `parseSamsungPowerState(payload: unknown): TvObservedPower` validates the envelope without retaining raw payload in errors.
- Signature refinement from spec: passing `PairingRequest` rather than a bare signal supplies saved credential to a fresh adapter without new hidden configuration or implicit pairing permission. LG's existing interface methods remain untouched.

- [ ] **Step 1: Add failing adapter tests**
  - `power states`: `on → on`, `standby → standby`, missing/empty/unknown/wrong-type value → unknown; malformed envelope is explicit `INVALID_TV_RESPONSE`.
  - `already desired`: no socket, no frame, `delivery === 'not_sent'`.
  - `guard after handshake`: initial standby, post-handshake on, desired on → no frame.
  - `unknown after handshake`: reject before frame.
  - `exact single toggle`: opposite state emits exactly `{ method: 'ms.remote.control', params: { Cmd: 'Click', DataOfCmd: 'KEY_POWER', Option: 'false', TypeOfRemote: 'SendRemoteKey' } }` once, both directions.
  - Saved-token handshake never initiates uncredentialed pairing. Existing ready owned socket is reused.
  - Abort before write yields `TvPowerSendError` with not_sent; write timeout/close/abort after write yields unknown. Late callback never sends again; cleanup failure remains observable.
- [ ] **Step 2: Run `pnpm --filter @remote-webos-tv/tizen test -- test/samsung-adapter.test.ts`; confirm new tests fail for absent power support.**
- [ ] **Step 3: Implement the interfaces and guards.** Reuse existing HTTP transport, scheduler, handshake and send lifecycle; share private frame-writing lifecycle with button sending rather than duplicate it. HTTP requests use bounded child AbortControllers with timers/listeners released in finally. Enable Samsung `powerOff`, keep `wakeOnLan: false`. Unknown states never permit sending. A new handshake's result is returned to the caller; failure during delivery wraps causal error with exact delivery classification.
- [ ] **Step 4: Run the narrow test, then Tizen full tests and tv-adapter/Tizen typechecks; require all to pass.**

### Task 2: Separate observed power and route Samsung through existing operations

**Files:**
- Modify: `packages/contracts/src/tv-power.ts` (and existing exports if required)
- Modify: `apps/api/src/tv/service.ts`
- Test: `packages/contracts/test/tv-power.test.ts`, `apps/api/test/tv-power.test.ts`, `apps/api/test/tv-power-routes.test.ts`

**Interfaces:**
- Consumes Task 1 optional adapter methods and `TvPowerSetResult`.
- Produces optional `TvPowerState.observedPower: 'on' | 'standby' | 'unknown'`; omit for LG.
- Existing `startPower`, `powerState`, operation schemas, routes and action names retained.

- [ ] **Step 1: Add failing contract/service/route tests.** Strict schema accepts the new enum only; old LG state remains valid. Samsung on enables off, standby enables wake without MAC even with available WSS, unknown disables both. Operation replay emits no extra frame; conflicting requests remain rejected. Test already-desired no-send success after cached state becomes stale; live HTTP guard is authoritative.
  - Fake adapter returns desired HTTP state while WSS remains available: operation succeeds without inventing connection loss.
  - WSS loss or HTTP failure alone never confirms standby.
  - Unknown delivery observes desired state without retry; expiry keeps unknown delivery and causal error.
  - Deferred reads/handshakes plus injected scheduler exercise cancellation, TV/session replacement and late completions; cleanup failure retains admission gate.
  - Reconnect uses persisted credential, and rotated handshake credential uses existing encrypted persistence path; storage failure prevents reporting a clean usable session.
  - Preserve existing LG power-off and WOL tests, MAC requirement, cancel, recovery and routes.
- [ ] **Step 2: Run `pnpm --filter @remote-webos-tv/api test -- test/tv-power.test.ts test/tv-power-routes.test.ts` and contract power tests; confirm targeted new failures.**
- [ ] **Step 3: Implement the Samsung path at service owner.** Observe HTTP during normal initialization/reconnect/status refresh using the existing probe ownership, scheduler and generation checks, without opening WSS just to observe. Begin with unknown, clear stale observations on generation replacement. Add no independent polling loop: reuse current status-refresh scheduling. Refresh failure stays explicit while observed state becomes unknown.
  - For Samsung operations, call `setPowerState` with saved credential and operation signal; do not pre-pair in service (it would bypass the pre-handshake guard).
  - Persist returned pairing metadata via existing encrypted replacement flow. Track delivery from result/error, never assuming sent before the adapter returns.
  - Observe desired HTTP state with existing `waitForTv` at maximum 1-second intervals within the existing budgets (off 5 seconds, wake recoveryTimeoutMs). Abort and generation checks surround every await.
  - Reuse existing error envelope: unknown observation `INVALID_TV_RESPONSE`; observation timeout `POWER_OFF_UNCONFIRMED` for off, `RECOVERY_TIMEOUT` for wake. Preserve specific transport/authorization/storage failures.
  - Successful Samsung off records standby separately; connection remains whatever actual transport checks establish. Successful wake establishes usable remote via existing recovery machinery, without another toggle. Cancellation/late completion must not reset terminal receipts.
  - Existing LG branch remains unchanged; do not broaden LG success claims.
- [ ] **Step 4: Run narrow tests, API/contracts full tests and typechecks. Require fresh passing results before Task 3.**

### Task 3: Samsung UI, minimal confirmation and regression checks

**Files:**
- Modify: `apps/web/src/pages/PowerControls.tsx`, `apps/web/src/pages/TvSetup.tsx`
- Test: `apps/web/src/pages/PowerControls.test.tsx`, `apps/web/src/pages/TvSetup.test.tsx`, `apps/web/test/e2e/tv-power.spec.ts`

**Interfaces:**
- Consumes `TvPowerState.observedPower` and existing TV platform context.
- Adds `platform?: TvPlatform` to PowerControls props; legacy callers default to existing LG behavior, TvSetup supplies actual platform.
- No new UI container, route or configuration.

- [ ] **Step 1: Add failing UI tests.** Samsung settings have no power heading, help, MAC input/save/clear or refresh-power control. Samsung standby/no MAC/available WSS shows enabled wake; unknown disables button and never asks to save MAC. Both LG settings and existing confirmation keyboard/focus behavior remain. LG success copy still warns physical state unconfirmed; Samsung success reflects observed standby. Minimal Samsung popup keeps title, close, cancel, confirm, no inapplicable connection-loss explanation.
- [ ] **Step 2: Run `pnpm --filter @remote-webos-tv/web test -- src/pages/PowerControls.test.tsx src/pages/TvSetup.test.tsx`; confirm new tests fail.**
- [ ] **Step 3: Implement platform-aware rendering.** Remove Samsung settings portal content entirely; use server permissions as canonical admission plus Samsung observed state (not MAC or connection) for action display. Preserve conflicting-permission fail-closed handling. Keep LG's existing details/copy. Do not change IP input, remote geometry or unrelated styles. Extend browser fixtures for separate power and connection state.
- [ ] **Step 4: Run narrow UI tests and `pnpm --filter @remote-webos-tv/web test:e2e -- test/e2e/tv-power.spec.ts`; verify target browser flows without real TV actions.**
- [ ] **Step 5: Run `pnpm typecheck`, `pnpm build`, `pnpm test`, full web browser suite and `git diff --check`; review whole diff and dispatch fresh whole-change reviewer.** Report actual passed/failed checks, skipped coverage and unverified physical behavior. Docker and real-TV checks are separate user-authorized handoffs, not proof provided by mocked tests.

## Self-review

All spec requirements map to Tasks 1–3; optional methods and observed field are additive, public operation delivery semantics remain intact. Five review-focus cases have explicit owning tests. Task 1 owns wire safety, Task 2 owns operation/persistence lifecycle, Task 3 owns platform-specific presentation. No production code, physical command or deployment is changed by this plan.
