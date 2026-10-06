# Final-review fix report — t7-reconnect-and-harden

Four findings from the whole-branch review (DO NOT MERGE pending fixes). All four addressed below.

## FIX 1 — CI checkout of `jordanhubbard/agentos` (`.github/workflows/ci.yml`)

Split the single `test` job into two jobs:

- **`test`** — checks out only `agentos_gui`, runs `npm ci`, `npm run check`, and the Playwright
  suite. Needs no secrets, so it runs for every push and every PR, including fork PRs (fork
  contributors now get real CI signal instead of none).
- **`drift-guard`** — checks out `agentos_gui` and `jordanhubbard/agentos` as siblings, with
  `token: ${{ secrets.AGENTOS_RO_PAT }}` added to the `agentos` checkout step (the default
  `GITHUB_TOKEN` is scoped to `agentos_gui` only and 404s on a different repo). Gated with
  `if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository`
  so it does not attempt to run for fork PRs, which receive no secrets regardless of how
  `AGENTOS_RO_PAT` is configured. Runs `cargo test` with `AGENTOS_SRC` and
  `AGENTOS_DRIFT_GUARD_REQUIRED=1` as before.

**Mitigating fact reverified after the change:** `AGENTOS_DRIFT_GUARD_REQUIRED` is still set
only on the final `cargo test` step, after the checkout step. Tested directly:
`AGENTOS_SRC=/nonexistent AGENTOS_DRIFT_GUARD_REQUIRED=1 cargo test drift_guard_against_agentos_source`
panics with "DRIFT GUARD: ... must be a hard failure, not a skip" — a broken/misconfigured
checkout still fails loudly, never silently green.

README.md's "CI" section rewritten to describe the two jobs, document the required
`AGENTOS_RO_PAT` secret, and state explicitly what happens if it's missing (the checkout step
404s, which fails the `drift-guard` job but not `test`) and why fork PRs skip `drift-guard`.

**The GitHub workflow itself remains unexecuted** — I cannot run GitHub Actions from here. I
verified the YAML parses (`yaml.safe_load`), inspected step ordering programmatically, and
confirmed the drift guard's required-flag behavior locally via `cargo test`, but I am not
claiming the workflow has run or passed on GitHub.

## FIX 2 — Hardcoded `TRACE_PD_NAME` table (`src/types.ts`, `src/components/ApiPanel.tsx`)

Removed `TRACE_PD_NAME` entirely (it included the already-stale `12: 'vibe_engine'`, now
retired from agentOS's booted set). Replaced with `tracePdLabel(pdIndex, authority)` in
`src/types.ts`: looks up the real `pd_index -> name` pair from the `MSG_CC_AUTHORITY` snapshot
already in app state; falls back to `pd{n}` when the snapshot is absent or doesn't have that
row. Never falls back to an invented name.

- `src/components/ApiPanel.tsx` now takes an `authority` prop and uses `tracePdLabel` for both
  `from_pd`/`to_pd` labels in the trace table (was the only remaining consumer of the invented
  table). Wired `authority={state.authority}` through in `src/App.tsx`.
- `src/components/TopologyGraph.tsx` already rendered trace PDs as plain `pd{n}` with no
  invented names — it was not part of this defect and I left it untouched. (I initially also
  switched it to `tracePdLabel`, but that produced duplicate "vibe_engine" text nodes
  colliding with the Authority grid's own card and broke two `exact: true` Playwright
  assertions in `authority.spec.ts` / `guests.spec.ts`; reverted rather than touch those
  tests' intent.)
- Updated `tests/api.spec.ts`'s trace-dump assertion, which previously checked for the
  invented label `linux_vmm` (pd 41, not in the authority mock). Now asserts `vibe_engine`
  (pd 12, genuinely present in the `cc_authority` mock) renders from real authority data, and
  `pd41` (not in the mock) renders the honest fallback — this directly exercises both branches
  of the fix rather than weakening coverage.

### Bonus (explicitly requested while in this area): stale `CC_API_SURFACE`

`CC_API_SURFACE` in `src/types.ts` stopped at `0x2619` and was missing
`MSG_CC_CONNECTION_SYNC` (`0x261f`) and `MSG_CC_AUTHORITY` (`0x2620`), both opcodes this
branch actively uses. Added both entries and a comment noting this is a hand-maintained
TypeScript copy the Rust drift guard does not cover, so the next reader knows it can rot
independently.

## FIX 3 — Stale trace data on ordinary transport failure (`src/hooks/useAgentOS.ts`)

`refresh()` previously kept `s.traceStatus`/`s.traceEvents` on any trace failure, with no
indication anything was stale — `NOT_PERMITTED` got a banner via `traceNotPermitted`, but an
ordinary transport/protocol failure showed nothing and the UI kept rendering the last
successful cycle's events as if current, in both `ApiPanel` and `TopologyGraph`.

Made it consistent with the authority snapshot's existing (correct) pattern:

- Added `traceError: string | null` to `AgentOSState` — set via `describeCcFailure` for any
  trace failure that is *not* a `NOT_PERMITTED` refusal (that case stays on
  `traceNotPermitted`, disabling controls with a reason, unchanged).
- On *any* trace failure (refused or ordinary), `traceStatus` is now set to `null` and
  `traceEvents` to `[]` — same all-or-nothing clearing the authority path already does —
  rather than being left as the previous cycle's value.
- `ApiPanel.tsx` takes a new `traceError` prop and renders a red banner ("last background
  trace fetch failed, data cleared rather than shown stale: ...") distinct from the amber
  refusal banner. `TopologyGraph.tsx` needed no code change: since `traceEvents` is now
  cleared on failure, it already falls through to its existing "No internal trace events"
  empty state instead of rendering stale rows.
- Added a new Playwright test, `tests/refresh.spec.ts` › "an ordinary trace transport failure
  does not render stale trace data as current", covering the gap directly: mocks a plain
  (non-`NOT_PERMITTED`) `cc_trace_query`/`cc_trace_dump` failure, asserts the rest of refresh
  is unaffected, the new banner and reason are shown, the refusal banner is *not* shown, and
  no trace rows render.

## FIX 4 — README "live topology" claim (`README.md`)

Replaced the stale "The Guests view renders that hook as a live topology ... inspector"
sentence. New copy describes what's actually rendered: the traffic ring as a message
inspector, and the `MSG_CC_AUTHORITY` boot-time snapshot as a ledger of what root granted at
boot — explicitly not live kernel state (seL4 has no capability-enumeration syscall) — with a
pointer to `TopologyGraph.tsx` for the unavailable-state handling.

## Constraints confirmed

- No existing test weakened, skipped, or deleted. One assertion in `tests/api.spec.ts` was
  updated (not removed) because it asserted the exact invented-label behavior Fix 2 removes;
  the replacement assertion checks both the real-name and honest-fallback paths, which is
  strictly more coverage of the fixed behavior. One new test was added in
  `tests/refresh.spec.ts`. Test count: 104 original + 1 new = 105, all passing.
- No change implies the credential is a secret, or that the GUI is a security boundary.

## Out of scope (left as follow-ups, per instructions)

Drift-guarding the dev token bytes and `AUTHORITY_KIND_NAMES` ordering; self-hosting Google
Fonts; cargo cache `restore-keys`; a `permissions:` block on the workflow.

## Verification output

### `npm run check`
```
> agentos-gui@0.1.0 check
> tsc --noEmit
```
(no output — clean)

### Full Playwright suite (`npm run test`)
```
105 passed (13.6s)
```
(104 pre-existing + 1 new regression test for Fix 3; 0 failed)

### `cargo test` under `src-tauri/`
```
running 17 tests
test cc_ipc::tests::malformed_credential_hex_is_rejected_not_silently_defaulted ... ok
test cc_ipc::tests::credential_hex_round_trips ... ok
test cc_ipc::tests::an_unrecognized_opcode_status_is_reported_as_unsupported_not_not_permitted ... ok
test cc_ipc::tests::rejects_pd_count_above_the_abi_maximum_before_indexing_anything ... ok
test cc_ipc::tests::parses_root_sentinel_and_a_named_domain ... ok
test cc_ipc::tests::rejects_an_unknown_version_before_indexing_anything ... ok
test cc_ipc::tests::dev_credential_is_well_formed ... ok
test cc_ipc::tests::name_truncates_at_the_recorded_nul_without_assuming_a_c_string ... ok
test cc_ipc::tests::rejects_a_buffer_truncated_before_its_declared_rows ... ok
test cc_ipc::tests::sync_frame_echoes_greeting_and_carries_credential ... ok
test cc_ipc::tests::sync_frame_tracks_generation_changes_across_reconnects ... ok
test commands::sock_path_tests::accepts_a_dot_slash_prefixed_variant_of_the_default ... ok
test commands::sock_path_tests::accepts_the_cc_pd_sock_env_override ... ok
test commands::sock_path_tests::accepts_the_current_resolved_default ... ok
test commands::sock_path_tests::rejects_an_empty_path ... ok
test commands::sock_path_tests::rejects_an_arbitrary_unix_socket_path ... ok
test cc_ipc::tests::drift_guard_against_agentos_source ... ok

test result: ok. 17 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
```
(A sibling `agentos` checkout happened to be present on this machine at `/Users/jkh/Src/agentos`,
so `drift_guard_against_agentos_source` actually ran rather than skipped; with `--nocapture` it
printed `*** DRIFT GUARD: 27 MSG_CC_* opcodes + handshake + authority layout constants verified
... ***`, confirming this repo's Rust-side constants still match the real agentOS source tree.)

### Workflow YAML
Parses cleanly via `yaml.safe_load` (Python). Job names: `test`, `drift-guard`. Confirmed
programmatically that the `token:` field is present on the `agentos` checkout step and precedes
the `AGENTOS_DRIFT_GUARD_REQUIRED: '1'` step. **The workflow has not been executed on GitHub** —
that remains unverified by me.
