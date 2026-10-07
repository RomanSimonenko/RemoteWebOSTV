# Dashboard design QA

final result: passed

## Evidence

Local, ignored evidence: `.local/dashboard-qa/`.

- Visual targets: `source-card.png`, `source-empty.png` (1487 × 1058 px).
- Browser captures: `dashboard-desktop.png`, `empty-desktop.png` (1487 × 1058 px); `dashboard-mobile.png`, `empty-mobile.png` (320 × 800 px).
- Full-view comparisons: `dashboard-desktop-comparison.png`, `empty-desktop-comparison.png`.
- Focused comparisons of card controls/type and empty-state hierarchy: `dashboard-desktop-detail.png`, `empty-desktop-detail.png`.
- CSS viewport: desktop 1487 × 1058, mobile 320 × 800; devicePixelRatio 1. Initial comparison captures used 1488 × 1056; this two-pixel edge difference does not affect the content assessment. No density resampling.

Both references and rendered captures were inspected together. All captured account/device data are synthetic. Empty and saved-device states were compared separately.

## Findings and comparison history

Initial comparison found P2 typography and empty-state hierarchy drift: heading/icon scale was too small. Increased desktop heading sizes, empty-state spacing and Tabler icon size; retained smaller mobile typography. Also corrected the status icon fill overridden by global SVG styles. Fresh browser captures and focused comparisons verify these corrections. No actionable P0/P1/P2 findings remain within the approved first-slice scope.

Intentional differences from the future-facing concept: one actual saved webOS device rather than three invented devices, model instead of an unsupported room nickname, no add action when already configured, no keyboard help on the dashboard, existing application shell width/theme and supplied LG logo. These follow the approved specification rather than pixel-copying unsupported features.

## Required fidelity surfaces

- Typography: existing system family and weights retained; title hierarchy and wrapping readable at both widths. Desktop h1 is 40 px, empty h2 35.2 px. Native browser text remains editable, not rasterized.
- Layout: card grid, consistent card padding, centered empty state and primary action. Mobile header wraps without hiding controls; document width equals the 320 px viewport.
- Colors: existing dark theme, blue primary action and semantic green/gray/red connection colors preserved. Focus/hover states remain native application styles.
- Assets: existing supplied LG logo and Tabler icons, no placeholder illustrations or generated brand marks. Monitor silhouette intentionally follows the established icon library.
- Copy: selected empty-state copy retained; real model/platform/status only. No IP, MAC or pairing key on the card.

## Interaction checks

Browser checked account settings opening/closing and focus return, card → remote → dashboard, mobile controls and console warnings/errors (none). Synthetic full-stack tests cover pairing, reload, session behavior and command boundaries; no real TV commands were sent during this QA.

## Checklist and follow-up

- [x] Open references and rendered screenshots; full-view and focused comparison.
- [x] Correct P2 findings and recapture.
- [x] Check mobile layout and primary navigation.
- [x] Preserve actual backend capabilities and existing visual system.

P3: exact reference monitor silhouette and background shading could be refined later; current library icons/theme are consistent with the application. Native physical-TV verification is left to the user.
