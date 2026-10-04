# Final independent review — power/WOL

Reviewed range: `a0d15e8..f62cea8413ec38db31249594616d04b187bb72bf` on `codex/power-wol`. Read applicable engineering rules, the requesting-code-review template, approved specification and plan. Reviewed production and test changes in separate contract/storage, service/lifecycle, protected API/session, transport, browser and integration/documentation passes. No nested reviewer or implementation agent was used.

## Strengths

- The canonical service owns admission, connection generations, monotonic deadlines, sequential recovery, terminal publication and cleanup. Pending transport/cleanup remains owned after timeout or cancellation; cleanup failures remain visible and deny subsequent unsafe admission (`apps/api/src/tv/service.ts:98-125,193-259,352-365,453-508`). The final disposal correction updates only the current available connection, preserving diagnostic and replacement states (`apps/api/src/tv/service.ts:102-115`).
- MAC persistence extends the existing private SQLite boundary with a nullable migration and shared validation. Registered discovery is committed only after a validated available snapshot; ordinary reconnect preserves an intentional null/manual value, and address replacement cannot silently retain another TV's MAC (`packages/contracts/src/tv-power.ts:4-8`; `apps/api/src/storage/database.ts:78-85`; `apps/api/src/tv/repository.ts:15-37`; `apps/api/src/tv/service.ts:148-175`). Migration/rollback, restart, malformed rows and key/account preservation have focused coverage.
- Authenticated power admission rechecks session and service state after limiter yielding, records acceptance before the asynchronous charge, and preserves terminal receipts before another recovery replaces current state. UUID possession cannot cancel another session's power operation; logout invalidates synchronously and awaits owned cleanup while still invoking all listeners (`apps/api/src/tv/power-routes.ts:26-34,62-91,93-105`; `apps/api/src/auth/sessions.ts:114-133`). Existing router-based Origin/CSRF/no-store protections remain in the real path.
- Browser mutation and polling ownership prevent double activation, automatic replay, overlapping reads and stale resurrection after MAC/cancel changes. Strict response identity/status checks preserve uncertainty; confirmation and physical-power wording are appropriately conservative (`apps/web/src/useTvPower.ts:29-119`; `apps/web/src/api.ts:67-83`; `apps/web/src/pages/PowerControls.tsx:7-32,63-80`). Seven built-browser scenarios reach real auth/API/SQLite/adapter, while real UDP is independently exercised on loopback with bounded receiver cleanup.

## Issues

### Critical (Must Fix)

None found.

### Important (Should Fix)

1. **Automatic recovery can request an interactive pairing prompt before rejecting it.**
   - References: `apps/api/src/tv/service.ts:143-148,345-347`; `packages/webos/src/lgtv2-adapter.ts:351-370,481-484`; `packages/webos/test/lgtv2-adapter.test.ts:292-305`.
   - The new automatic recovery passes `allowPairingPrompt: false`, but that option only handles the client's `prompt` event after a TV response. The actual installed `lgtv2@2.0.0` producer always copies `pairing.json`, whose registration payload is `pairingType: "PROMPT"`, then adds the stored key (`node_modules/.pnpm/lgtv2@2.0.0/node_modules/lgtv2/index.js:666-694`; `pairing.json:2-3`). A TV that no longer accepts the key can therefore start interactive pairing before the adapter rejects/disconnects. This inherited adapter limitation becomes an unattended action through the new automatic-recovery caller.
   - Fresh bounded reproduction against the existing protocol mock, using the final staging adapter and a synthetic revoked saved key with `allowPairingPrompt: false`, returned `AUTHORIZATION_FAILED` **and `promptCount: 1` with one registration**. Thus the refusal prevents accepting/saving a new key; it does not prevent requesting the prompt. The existing test verifies rejection, cleanup and no key save but does not assert zero prompts. Happy-path hardware/mock recovery with a still-valid key does not cover this condition.
   - Impact: an ordinary disconnection after authorization revocation may display an unsolicited TV access prompt, violating the specification's explicit automatic-recovery/no-new-pairing requirement. This is not an authorization bypass or duplicate WOL; severity is Important, not Critical.
   - Fix at the registration producer: use a protocol-supported, verified path that forbids interactive pairing during saved-key recovery and test a revoked key through the actual wire path, asserting zero prompts as well as terminal authorization failure/no retry. If the current protocol/library cannot provide that guarantee, explicitly resolve the limitation and obtain an approved requirement adjustment rather than treating post-prompt rejection as proof that no prompt was requested. Do not invent an unsupported registration mode or silently disable all recovery.

### Minor (Nice to Have)

None recorded.

## Verification and evidence boundaries

- Reviewer ran fresh `git diff --check a0d15e8 f62cea8`: exit 0.
- One named-risk check only: a bounded Node script in retained isolated staging imported the built production adapter and existing mock-TV, attempted registration with a synthetic revoked key, then awaited adapter/mock cleanup. Restricted execution failed at loopback bind with `EPERM` before exercising application behavior; the same scoped check with permitted loopback execution exited 0 and printed `{"outcome":"rejected","code":"AUTHORIZATION_FAILED","promptCount":1,"requestCount":1}`. No live API, real TV, private data, browser, build or source mutation was involved.
- Final source execution evidence was inspected in Task 1–5 reports and `manual-owner-fix-report.md`/review. The controller additionally supplied a fresh full isolated run: 815 tests (231 contracts + 115 webOS + 140 web + 269 API + 60 probe), exit 0, and byte-comparison of scoped source/config paths against staging, exit 0. Final executable source at `ea8280b` matches the reviewed head; later changes are documentation/evidence. Typecheck/build and full Chromium 23/23 are recorded on that final executable snapshot. These broad results are controller/implementer evidence, not invented reviewer reruns; the missing revoked-key no-prompt assertion is not covered by their passing counts.
- Graft was attempted first. The tool resolves the primary checkout rather than the target worktree: it reported no committed graph manifest, while its tier-0 wiring graph was in sync for that primary checkout. Returned session/runtime symbols were older than this reviewed worktree. Exact target-worktree source/diff supplied review evidence; no graph rebuild was performed. Graft reported approximately 11,717 tokens saved for its one query, but that query was not used as proof of this branch's behavior.
- Review preserved checkout, index, HEAD, ignored private backups, prior SDD trees, live server and TV. Only this report was written.

## Declined to judge

- Independent physical-screen/LAN-broadcast proof: this source review cannot establish it and did not repeat hardware actions. The accepted owner's off/WOL/no-new-prompt/reload/relogin observations are explicitly qualified in the compatibility report; they concern the tested valid-key path, not the revoked-key finding above.
- The disclosed fresh-checkout build/typecheck bootstrap gap: it predates this range and is documented as a separate build-graph issue; no new regression or hidden passing-build claim was found in this change.
- Docker deployment, HTTPS delivery and compatibility with untested TV models: explicitly outside this approved slice, with no claimed completion here.

## Assessment

**Ready to merge: With fixes.**

The state/cleanup, API replay protection, persistence and browser behavior are well bounded and extensively checked. Resolve the one Important automatic-registration contract gap, then verify the revoked-key/no-prompt path at its producer boundary; otherwise the branch claims a guarantee its actual registration request does not enforce.
