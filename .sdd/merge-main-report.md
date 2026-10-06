# Merge report: `origin/main` -> `t7-reconnect-and-harden` (PR #17)

Date: 2026-10-03
Merge base: `d40bf01` — `origin/main` had moved 66 commits ahead.
Command: `git merge origin/main` (no rebase, no force-push, PR not merged).

Three files conflicted: `src-tauri/src/cc_ipc.rs` (6 hunks),
`src-tauri/src/commands.rs` (1 hunk), `src/hooks/useAgentOS.ts` (1 hunk).

## Per-hunk resolution

| # | File / location | Kind | Rule applied |
|---|---|---|---|
| 1 | `src/hooks/useAgentOS.ts` type import list | additive | **Union.** T7 added `AuthoritySnapshot`; main added `DesktopInputEvent`, `InputBatchAck`. All three kept; no entry dropped or duplicated. |
| 2 | `src-tauri/src/commands.rs` `use crate::cc_ipc::{...}` | additive | **Union.** T7's `AuthoritySnapshot` plus main's `DesktopInputEvent`, `FrameInfo`, `InputBatchAck`. Re-sorted alphabetically, re-wrapped; 22 distinct names, none lost. |
| 3 | `cc_ipc.rs` MSG_CC_* opcode constants | additive | **Union.** Main's `MSG_CC_FRAME_CAPTURE = 0x261D` and `MSG_CC_INPUT_SUBMIT = 0x261E` plus T7's `MSG_CC_CONNECTION_SYNC = 0x261F` and `MSG_CC_AUTHORITY = 0x2620`. Kept in ascending opcode order. Disjoint values — no collision. |
| 4 | `cc_ipc.rs` `CcClient::connect` bootstrap call | **true semantic collision** | **T7 wins (per ruling).** See below. |
| 5 | `cc_ipc.rs` `opcode_name()` match arms | additive | **Union**, all three arms present exactly once. |
| 6 | `cc_ipc.rs` `opcode_has_ok_mr()` match | additive | **Union**, all three opcodes present exactly once. |
| 7 | `cc_ipc.rs` `reply_shmem_len()` match | additive | **Union**, all three arms present exactly once. Arms are mutually exclusive (distinct opcodes), so ordering is not load-bearing. |
| 8 | `cc_ipc.rs` `#[cfg(test)]` module | additive + one assertion rewrite | **Both modules kept side by side**: T7's `mod tests` and main's `mod console_tests`, each with its own `#[cfg(test)]`. One test inside `console_tests` was renamed and its payload assertion corrected (below). |

Explicitly *not* applied: blind concatenation. Hunks 3-7 were checked
individually for duplicated/dropped entries; hunk 8's closing brace was
reconstructed by hand rather than taken from either side (both sides shared a
single trailing `}` in the conflict region — naive concatenation would have
produced an unbalanced brace, the exact failure mode flagged in the brief).

## The real collision: the `cc_pd` connection bootstrap

Both branches independently implemented the bootstrap.

- `origin/main`'s `synchronize_connection(stream)` read the greeting, validated
  magic/version/nonzero-generation/zero-reserved-bytes, echoed the frame back
  with the opcode swapped to `MSG_CC_CONNECTION_SYNC`, and **sent an all-zero
  payload** — no operator credential.
- T7's version resolved the operator credential first and wrote it into
  `shmem[0..CC_OPERATOR_TOKEN_BYTES]`, rest zeroed.

**Ruling applied: T7's version wins.** agentOS has since merged T1, which makes
`cc_pd` validate an operator credential at `MSG_CC_CONNECTION_SYNC`. A zero
credential is refused, so main's handshake cannot connect to current agentOS at
all.

Resolution shape:

- Main's `synchronize_connection` body was **replaced** with T7's logic
  (`operator_credential()` -> `CcClient::read_greeting` ->
  `CcClient::send_sync`). The *name* and call shape were kept so main's test
  and call sites still work; the *semantics* are T7's. `CcClient::connect` now
  calls it instead of inlining the three steps, so there is exactly one
  implementation of the bootstrap.
- Main's greeting-side validation was **not** discarded — the ruling concerns
  what the client *sends*, not what it *accepts*. Main's version /
  nonzero-generation / zero-reserved-byte checks were folded into T7's
  `CcClient::read_greeting` (which previously validated only the magic). These
  are proven against the real `cc_pd` (main PR #16) and are purely additive
  hardening.
- Main also re-declared `CC_CONNECTION_MAGIC`, `CC_CONNECTION_VERSION` and
  `MSG_CC_CONNECTION_SYNC` privately next to the wire-size constants. Those
  duplicates were removed (they collided with T7's public declarations and broke
  the build with `E0428`); a comment points at the single public declaration.

## The test that encoded the wrong requirement

`console_tests::bootstrap_requires_exact_generation_and_zero_payload` asserted
the sync frame's payload was all zeros — the requirement T7 deliberately
violates. It was **not deleted**:

- Renamed to `bootstrap_requires_exact_generation_and_credential_payload`, with
  a doc comment explaining why the payload is not zero.
- The payload assertion now builds the expected frame explicitly: opcode
  `MSG_CC_CONNECTION_SYNC`, version and generation echoed verbatim from the
  greeting, `dev_operator_credential()` in `shmem[0..CC_OPERATOR_TOKEN_BYTES]`,
  plus two extra assertions — the credential bytes are not all zero, and every
  byte after the credential is zero.
- **All five modes and every other assertion preserved byte for byte**: the
  nonblocking "client must not speak first" check, mode 1 (bad version), mode 2
  (zero generation), mode 3 (trailing nonzero reserved byte), mode 4 (reply with
  a mutated generation), and the `is_ok() == (mode == 0)` expectation.
  Folding main's greeting validation into `read_greeting` is what keeps modes
  1-3 failing *for their original reason* rather than incidentally.
- The module's other test,
  `public_handle_console_validates_wire_status_length_and_identity`, is kept
  unchanged and passes.

## Capability allowlist audit (the silent-breakage check)

`origin/main` granted the blanket `core:default`. T7 replaced it with an
explicit per-command allowlist, so every command main added since the branch
point would have been unreachable at runtime after this merge — no compile
error, just a dead feature.

Enumerated all `#[tauri::command]` functions in the merged tree (35) and
cross-checked four sets that must agree:

- `#[tauri::command]` declarations in `commands.rs`: 35
- `tauri::generate_handler![]` in `lib.rs`: 35
- `tauri_build::AppManifest::commands()` in `build.rs`: 35
- `capabilities/default.json` permissions: 35

All four now agree exactly (verified programmatically: every pairwise set
difference is empty).

**Added to `capabilities/default.json` (5):**

| Permission | Why it was missing |
|---|---|
| `allow-cc-input-submit` | main added it (desktop input batching, `MSG_CC_INPUT_SUBMIT`) |
| `allow-cc-frame-capture` | main added it (frame capture, `MSG_CC_FRAME_CAPTURE`) |
| `allow-cc-frame-read` | main added it (frame capture) |
| `allow-cc-frame-release` | main added it (frame capture) |
| `allow-cc-is-connected` | **pre-existing T7 bug**, not a merge consequence: the command existed at the merge base and is in `generate_handler!`/`build.rs`, but T7's 29-entry allowlist omitted it |

**Also required, and initially missed by an allowlist-only fix:**
`src-tauri/build.rs` generates the per-command ACL permissions. The four new
commands were absent from its `AppManifest::commands()` list, so
`tauri-build` rejected the new capability entries outright
(`Permission allow-cc-input-submit not found`). They were added there too.
This is worth noting: editing `capabilities/default.json` alone is not
sufficient in this repo.

## Drift guard

T7's `drift_guard_against_agentos_source` was extended with main's two new
opcodes. It runs here against the real sibling tree at `/Users/jkh/Src/agentos`
and now reports:

```
*** DRIFT GUARD: 29 MSG_CC_* opcodes + handshake + authority layout constants
    verified against .../agentos ***
```

Both merged-in values were confirmed against
`kernel/agentos-root-task/include/agentos.h` lines 988-989
(`MSG_CC_FRAME_CAPTURE 0x261D`, `MSG_CC_INPUT_SUBMIT 0x261E`). It is a real
pass, not the loud skip.

## Verification

| Check | Result |
|---|---|
| `cd src-tauri && cargo build` | pass |
| `cd src-tauri && cargo test --lib` | 32 passed, 1 failed (pre-existing, see below) |
| `npx tsc --noEmit` (`npm run check`) | pass, clean |
| `npx vite build` | pass (1605 modules) |
| `npm run test` (Playwright, 142 specs) | 142 passed |
| drift guard | pass, 29 opcodes verified against the real agentOS headers |

`npm run build` is `tauri build` (a full release bundle); the frontend half of
it, `vite build`, was run directly, and the Rust half is covered by
`cargo build`.

### Pre-existing failure, not introduced by this merge

`cc_ipc::desktop_input::tests::partial_reply_closes_transport_without_retrying_input`
fails on this machine. Confirmed pre-existing by checking out `origin/main`
(`41b6c1e`) into a scratch worktree and running its own suite: the same test
fails there, deterministically, 3/3 runs, with an identical panic
(`desktop_input.rs:223`, `left: 1, right: 0`). The merged tree fails the same
single test, 3/3 runs. Left alone — fixing it is out of scope for this merge
and would muddy the diff. It appears to be a macOS socket-shutdown behaviour
difference; CI runs on `ubuntu-latest`.

## Nothing unresolved

No conflict was left for a human to arbitrate.

## Recommendation (not done, out of scope)

There is no automated guard keeping `commands.rs` / `lib.rs` / `build.rs` /
`capabilities/default.json` in agreement. This merge found two real gaps in
that agreement (four commands from main, plus one that T7 itself had missed),
and nothing would have failed to compile. A small `#[test]` parsing the four
lists and asserting set equality would turn the next occurrence into a red
test instead of a silently dead feature.
