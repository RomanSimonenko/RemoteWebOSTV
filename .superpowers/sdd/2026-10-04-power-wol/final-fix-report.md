# Final review fix round 1 — registration guarantee limitation

Status: **NEEDS_CONTEXT / publication blocker remains**. BASE/HEAD: `f62cea8413ec38db31249594616d04b187bb72bf`, branch `codex/power-wol`. No production/test change or checkpoint commit. The approved zero-interaction requirement cannot be supported by the installed registration producer, and bounded primary-source research did not establish a compatible replacement path. This is not a claim that every possible webOS implementation lacks such a path.

## Scope and investigation

Read the fix brief, final independent review, approved power specification/plan, applicable engineering instructions, systematic-debugging and TDD skills, and the writing-good-tests reference. Inspected the adapter, client types, recovery owner/callers, installed `lgtv2@2.0.0` implementation/types/template and existing mock producer. No live API, permanent data, TV, browser, worktree build, dependency installation, push or merge was used. Existing graft artifacts were preserved. The only executable investigation artifact is `recovery-registration-research.mjs` in retained staging basename `remote-webos-power-e2e.4wROKU`.

Graft was queried before a possible patch to establish adapter callers. It resolved the primary checkout and returned older symbols rather than this worktree; exact target source supplied the actual boundary evidence. Graft's reported estimate was 10,429 saved tokens; no graph mutation was performed.

## Root cause and actual producer

- `packages/webos/src/lgtv2-adapter.ts:351-370` passes the saved key and owns key storage, deadlines and cleanup; `:481-484` rejects a `prompt` event only after the registration response.
- `apps/api/src/tv/service.ts:143-148` authorizes prompts only for explicit pair/repair; recovery passes the restrictive option into the same adapter. Ordinary disconnect recovery uses that connection owner too (`:345-347`).
- Installed `lgtv2/index.js:666-694` copies its registration template, adds the saved key, sends `register`, then emits `prompt` when the response lacks a key. `pairing.json:2-3` contains `forcePairing:false` and `pairingType:"PROMPT"`. Its public options contain no registration policy/no-interaction parameter. `forcePairing:false` already exists in the failing wire sample, so adding it is not a fix.
- The receiver can request interaction before the adapter rejects. Post-response rejection, disconnection, cancellation or suppression of the event cannot prove zero requested prompts. Missing-key preflight alone would leave revoked keys affected.

## Bounded authoritative research

Primary sources checked on 2026-10-04:

1. [lgtv2 upstream registration implementation](https://github.com/hobbyquaker/lgtv2/blob/master/index.js) and [template](https://github.com/hobbyquaker/lgtv2/blob/master/pairing.json). Current upstream has an unsigned-manifest compatibility fallback, but its normal registration still uses the template and emits prompt after the response; no no-interaction registration contract was identified. Installed 2.0.0 is the executable authority here. Upgrading does not establish the required guarantee.
2. [ConnectSDK Android WebOSTVServiceSocketClient](https://github.com/ConnectSDK/Connect-SDK-Android-Core/blob/master/src/com/connectsdk/service/webos/WebOSTVServiceSocketClient.java), `sendRegister` lines 547-607: serializes stored client-key and manifest, optionally PIN. `PairingType.NONE` is local interpretation of a response, not a serialized registration enum. Omitting pairingType therefore has no documented revoked-key/no-prompt guarantee; sending NONE would invent a wire contract. PIN remains interactive.
3. [ConnectSDK PairingLevel documentation](https://connectsdk.com/en/latest/apis-and/and-pairinglevel.html) describes OFF at SDK service/discovery level. [Actual WebOSTVService producer](https://github.com/ConnectSDK/Connect-SDK-Android-Core/blob/master/src/com/connectsdk/service/WebOSTVService.java), lines 2227-2252 and 2297-2308, removes protected permissions/capabilities at lower levels; key control and power-off belong to the protected path. OFF is not evidence of safe registration with the existing protected manifest/key. Substituting that path changes capabilities and the registration contract.
4. Scoped searches of LG webOS developer sources and ConnectSDK did not yield a documented key-validation-only SSAP method or no-interaction registration option. This negative search is bounded evidence, not proof of protocol-wide impossibility.

No speculative enum, dependency override, reduced permission manifest, raw socket replacement or mock acceptance rule was implemented.

## Fresh executable evidence

The research script imports the already-built production adapter and existing protocol mock from retained isolated staging. All identifiers/keys are synthetic. Actual `ws.send` frames are observed and forwarded unchanged; output retains only type, pairing policy and key/manifest presence. The mock supplies controlled responses with a deterministic registration barrier. It was not modified to validate a proposed protocol behavior.

Command: `node recovery-registration-research.mjs` in retained staging. Restricted execution failed before exercising behavior at loopback bind with `EPERM`; scoped permitted loopback execution was then used. The first capture assertion failed because the existing mock intentionally omits registration payload from its recorded request list. Reading that producer identified the harness assumption; observation moved to the real outbound frame without changing production or mock semantics. Corrected execution exited 0 with:

| Controlled input | Outcome | Prompts | Registrations | Key saves | Active sockets after cleanup |
|---|---|---:|---:|---:|---:|
| Revoked saved key, prompts forbidden | AUTHORIZATION_FAILED | 1 | 1 | 0 | 0 |
| Valid saved key, prompts forbidden | Registered | 0 | 1 | 0 | 0 |
| Missing key, prompts forbidden | AUTHORIZATION_FAILED | 1 | 1 | 0 | 0 |
| Explicit pair, prompts authorized | Registered | 1 | 1 | 1 | 0 |

Every outbound registration had `type:"register"`, `forcePairing:false`, `pairingType:"PROMPT"`, and a manifest. Key presence matched the input. The script asserts all outcomes/counts and awaits adapter/mock cleanup; no sleep or automatic retry establishes the result. Synthetic prompt counts demonstrate the receiver path; this investigation makes no fresh physical-screen claim.

Fresh `cmp` checks confirmed staging adapter source and installed lgtv2 producer equal their target-worktree counterparts (both exit 0). `git diff --check` exited 0; no tracked code/index change was made by this investigation, HEAD remains BASE, unrelated `graft/` remains untracked. Concurrent controller documentation changes were visible in README, compatibility report, roadmap and approved plan and were preserved. No RED/GREEN implementation cycle, full suite, typecheck/build or browser test was run because no implementation was made. Previously recorded 815/815 and hardware valid-key acceptance remain historical evidence and do not cover this guarantee.

## Requirement choices for the user/controller

1. Preserve bounded saved-key recovery, explicitly revise the guarantee to forbid accepting/storing a replacement key and continuing after a prompt response. The user must accept that a revoked key can briefly request TV interaction; documentation, tests and UI expectations must state that limit. A fast registration success remains expected for valid keys. This is a requirement change, not a fulfilled zero-prompt fix.
2. Preserve strict zero unattended interaction by removing unattended registration after disconnect/WOL, and make reconnection an explicit authorized action that warns it can request TV access. WOL would report packet sent and wait for that action, without claiming restored control. Manual authorization must cover reconnect/initialize surfaces as well; keeping automatic initialize registration would preserve the same risk. This changes approved recovery behavior and acceptance criteria and must not be applied silently.
3. Keep the current requirement and hold publication until a documented upstream/vendor key-only registration contract and compatible producer are supplied. Validate that path before implementation through actual wire samples, revoked/valid/missing key cases, explicit repair and adjacent cancellation/fallback cleanup. Hardware scope would need separate authorization.

No choice was made on the user's behalf. The Important review item remains unresolved; the branch must not be presented as satisfying zero automatic pairing prompts. There is no source patch to review or deploy from this wave.

## Subsequent user decision — 2026-10-04

After this investigation, the user explicitly accepted option 1: retain bounded saved-key recovery and document that a revoked key may cause a TV access prompt before the adapter rejects the prompt-requiring response. The spec and acceptance criteria now require rejection/no replacement-key save/no automatic retry after that response, not a guarantee of zero displayed prompts for revoked keys. This is a user-approved requirement adjustment, not a production fix. The controller removes the publication blocker for this finding; separate merge authorization and GitHub workflow remain required. The NEEDS_CONTEXT verdict above records the original investigation checkpoint.
