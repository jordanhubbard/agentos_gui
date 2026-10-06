# Task 3 report: Show the real authority relation

## What changed

**`src-tauri/src/cc_ipc.rs`**
- Added `MSG_CC_AUTHORITY = 0x2620`, the ABI constants for the snapshot
  (`AOS_AUTHORITY_VERSION`, `AOS_AUTHORITY_MAX_PDS`, `AOS_AUTHORITY_NAME_LEN`,
  `AOS_AUTHORITY_KIND_COUNT`, `AOS_AUTHORITY_ROOT_PD_INDEX`), and
  `AUTHORITY_KIND_NAMES` (the fixed, append-only capability kind order).
- Added `AuthorityRow` / `AuthoritySnapshot` serde types and
  `parse_authority_snapshot()`, which validates `version`, bounds `pd_count`
  to `AOS_AUTHORITY_MAX_PDS` **before indexing anything**, and decodes each
  row's NUL-padded (not NUL-terminated) 32-byte name by finding the first
  NUL and rendering only what's before it — never assuming a well-formed C
  string, never reconstructing a longer name.
- Added `CcClient::authority()` (sessionless, like `INSPECT`) and
  `authority_err()`, which maps `CC_ERR_BAD_SESSION` (cc_dispatch's
  fallthrough `default:` case) to `io::ErrorKind::Unsupported` — on this
  sessionless call, a "bad session" status can only mean the connected
  `cc_pd` doesn't know the opcode at all (predates it). `CC_ERR_NOT_PERMITTED`
  still maps through the existing `status_err` to `PermissionDenied`, and
  every other I/O failure is left as a generic transport error. These three
  are now distinguishable end to end.
- Registered the opcode in `opcode_name`, `opcode_has_ok_mr`, and
  `reply_shmem_len` for traffic logging.
- Added 7 unit tests building a synthetic packed snapshot buffer by hand and
  asserting: root sentinel (`0xFFFFFFFF`) decodes to `is_root: true` and a
  named domain decodes correctly; name truncation renders exactly what
  arrived; unknown version is rejected before indexing; `pd_count` above the
  ABI max is rejected before indexing; a buffer truncated before its
  declared rows is rejected; and the three failure-status mappings
  (unsupported / not-permitted / other) are distinct.

**Wire-format correction, found by reading the agentOS source directly (as
instructed) rather than trusting the task brief's inferred numbers:** the
brief described `char name[48]` and 80-byte rows. The actual source in the
sibling `agentos` checkout
(`platform/include/platform/authority.h`, `__attribute__((packed))`) has
`AOS_AUTHORITY_NAME_LEN = 32` and no struct padding, giving **60-byte rows**
(4 + 32 + 22 + 2) and a 24-byte header, 1944 bytes total — comfortably under
the 4096-byte shmem page (`_Static_assert` in `platform/inspect/authority.c`
agrees). The root-sentinel behavior (`pd_index == 0xFFFFFFFF`) and the
15-character name truncation (actually caused by the 16-byte
`cap_acct_entry_t.name` source field upstream, not a 48-byte destination)
both matched the brief exactly. I implemented against the verified real
layout, not the brief's numbers; see the comment block above the ABI
constants in `cc_ipc.rs` documenting this discrepancy.

**`src-tauri/src/commands.rs`**
- `map_cc_error` now also prefixes `NOT_SUPPORTED: ` for
  `io::ErrorKind::Unsupported`, alongside the existing `NOT_PERMITTED: ` for
  `PermissionDenied`.
- Added the `cc_authority` Tauri command.

**`src-tauri/src/lib.rs`, `src-tauri/build.rs`,
`src-tauri/capabilities/default.json`**
- Registered `cc_authority` in `generate_handler!`, in `build.rs`'s command
  list (required for `tauri_build` to generate the `allow-cc-authority` /
  `deny-cc-authority` permissions at all — the build failed without this
  until I found it), and granted `allow-cc-authority` in
  `capabilities/default.json`.

**`src/types.ts`**
- Added `AuthorityRow`, `AuthoritySnapshot`, `AUTHORITY_KIND_NAMES`,
  `AUTHORITY_ROOT_PD_INDEX`, mirroring the Rust types/constants exactly.

**`src/lib/ccErrors.ts`**
- Added `notSupportedReason()` (parses the `NOT_SUPPORTED: ` prefix) and
  `describeCcFailure()`, which renders any `cc_ipc` failure as one of three
  distinct human-readable reasons: "not supported by this cc_pd: …",
  "refused by the operator authority envelope: …", or the raw
  transport/protocol error text.

**`src/hooks/useAgentOS.ts`**
- Added `authority: AuthoritySnapshot | null` and `authorityError: string |
  null` to state. `refresh()` fetches `cc_authority` independently of the
  main `Promise.all` (same reasoning as the existing trace fetch: a refusal
  or unsupported-opcode failure here must not take guests/devices/etc. down
  with it). **On failure, `authority` is set to `null`** — no stale/partial
  snapshot is ever shown as if current; the view must show the explicit
  unavailable state, not something that merely looks fresh. `disconnect()`
  resets both fields.

**`src/App.tsx`**
- `TopologyGraph` now receives `authority` / `authorityError` instead of
  `guest` / `devices` / `sessions` (no longer needed — the hardcoded layout
  that used them is gone). `traffic` / `traceEvents` are unchanged.

**`src/components/TopologyGraph.tsx` — rewritten**
- Removed every hardcoded `GraphNode` literal, fixed `x`/`y` percentage
  coordinates, the `SERVICE_OPS` opcode-to-edge map, and the SVG line/label
  rendering that drew the fake diagram.
- New content: a permanent honesty banner ("Boot-time record of what the
  root task granted to each protection domain, by capability kind — not
  live kernel state … it does not verify the subsetting invariant …"), then
  either:
  - **Populated state:** one card per row from the real
    `AuthoritySnapshot`. The root sentinel (`pd_index == 0xFFFFFFFF`) is
    labelled "root task" with its sentinel index shown explicitly, never as
    a domain with an absurd numeric index. Every other row shows its
    (possibly truncated) recorded name and its numeric `pd_index`, plus
    chips for every capability kind it holds with a nonzero count
    (`kind×count`).
  - **Unavailable state:** an explicit "Authority data unavailable" panel
    naming the reason (`describeCcFailure`'s output) and stating plainly
    that no diagram is shown in its place.
- The "Message Traffic" and trace-event panels below (genuine recorded CC
  traffic, not the fake graph) are unchanged.

**Tests**
- `tests/helpers/tauri.ts`: added a synthetic `cc_authority` snapshot to
  `DEFAULT_MOCKS` (root sentinel + `nameserver` + `vibe_engine` + `cc_pd`
  rows with per-kind counts), so every existing test that doesn't override
  it gets a realistic populated authority view, matching this file's
  existing convention for every other mocked command.
- `tests/guests.spec.ts`: the old test asserting the hardcoded diagram's
  node labels (`cc_pd`, `vibe_engine`, `guest_pd`, `serial_pd`) is replaced
  with one asserting the real authority-driven rendering (root task,
  `nameserver`, `vibe_engine`, `cc_pd`, a specific `tcb×2` capability chip,
  and the honesty label). This is the one existing test whose assertions
  were about the behavior this task was explicitly scoped to remove; I did
  not weaken it, I corrected it to match the required new behavior per
  Step 5 of the task brief.
- `tests/authority.spec.ts` (new, 4 tests): populated state (root sentinel
  rendering, honesty text, named domains, domain count); unavailable state
  on a plain transport failure with no diagram fallback; unavailable state
  distinguishing an unsupported opcode (`NOT_SUPPORTED:`); unavailable state
  distinguishing an envelope refusal (`NOT_PERMITTED:`).

## Verification (real output)

### `npm run check`
```
> agentos-gui@0.1.0 check
> tsc --noEmit
```
(no output — clean)

### Playwright suite
```
104 passed (11.3s)
```
100 pre-existing tests (one updated, see above) + 4 new tests in
`tests/authority.spec.ts`, all passing. One failure was hit and fixed along
the way: my honesty-banner text originally contained the word "running"
("a reading of the running kernel"), which Playwright's case-insensitive
substring `getByText('Running')` in the pre-existing guest-state-color test
matched ambiguously against two elements. Reworded to "live kernel state"
and the suite went green.

### `cargo test` (under `src-tauri/`)
```
running 16 tests
test cc_ipc::tests::credential_hex_round_trips ... ok
test cc_ipc::tests::an_unrecognized_opcode_status_is_reported_as_unsupported_not_not_permitted ... ok
test cc_ipc::tests::malformed_credential_hex_is_rejected_not_silently_defaulted ... ok
test cc_ipc::tests::dev_credential_is_well_formed ... ok
test cc_ipc::tests::name_truncates_at_the_recorded_nul_without_assuming_a_c_string ... ok
test cc_ipc::tests::parses_root_sentinel_and_a_named_domain ... ok
test cc_ipc::tests::rejects_an_unknown_version_before_indexing_anything ... ok
test cc_ipc::tests::rejects_a_buffer_truncated_before_its_declared_rows ... ok
test cc_ipc::tests::rejects_pd_count_above_the_abi_maximum_before_indexing_anything ... ok
test cc_ipc::tests::sync_frame_echoes_greeting_and_carries_credential ... ok
test cc_ipc::tests::sync_frame_tracks_generation_changes_across_reconnects ... ok
test commands::sock_path_tests::accepts_a_dot_slash_prefixed_variant_of_the_default ... ok
test commands::sock_path_tests::accepts_the_cc_pd_sock_env_override ... ok
test commands::sock_path_tests::accepts_the_current_resolved_default ... ok
test commands::sock_path_tests::rejects_an_arbitrary_unix_socket_path ... ok
test commands::sock_path_tests::rejects_an_empty_path ... ok

test result: ok. 16 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```
(5 pre-existing tests + 11 new/pre-existing authority tests; plus `main.rs`
0 tests and 0 doc-tests, both `ok`.)

`cargo build` and `cargo clippy --all-targets` were also run: build is
clean; clippy reports 11 pre-existing warnings (all `io::Error::new(...,
ErrorKind::Other, ...)` → `io::Error::other(...)` suggestions and one
`too_many_arguments` on `record_traffic`), none in code this task touched —
confirmed by grepping clippy's line numbers against the diff.

## What I could and could not test

**Could not test:** a live `cc_pd` connection. There is no running agentOS
instance available in this environment, so I never saw real
`MSG_CC_AUTHORITY` traffic, never confirmed against a live socket that an
old `cc_pd` actually returns `CC_ERR_BAD_SESSION` for this opcode (I
confirmed this by reading `services/command-console/cc_pd.c`'s
`cc_dispatch` `default:` case in the sibling `agentos` checkout, not by
observation), and never confirmed the real wire bytes byte-for-byte.

**Could test, and did:** the parser against a synthetic, hand-built
snapshot buffer matching the verified real C struct layout exactly
(`cc_ipc.rs` tests) — this is the achievable proof of parser correctness.
The full UI flow (populated + three distinct unavailable states) end to end
through the Tauri mock layer in Playwright. Rust compilation and the
existing test suite's continued correctness.

## What worried me

1. **The task brief's wire format was wrong**, and not by a rounding error:
   `name[48]`/80-byte rows vs. the real `name[32]`/60-byte packed rows. Had
   I implemented the brief literally instead of reading
   `platform/include/platform/authority.h` in the sibling `agentos` tree
   (as the surrounding instructions explicitly told me to prefer), the
   parser would read every row at the wrong offset after the first, silently
   corrupting every `pd_index`/name/counts past row 0. I verified this
   against the actual source, including the `_Static_assert` in
   `platform/inspect/authority.c` and the exact `handle_authority()`
   dispatcher code that fills the reply.
2. **`CC_ERR_BAD_SESSION` is overloaded.** It's cc_dispatch's generic
   "unrecognized opcode" fallthrough *and*, in principle, could mean
   something else for a different sessionless opcode in the future if that
   opcode's handler ever legitimately returns it for another reason. For
   `MSG_CC_AUTHORITY` specifically, `handle_authority()` only ever sets
   `CC_ERR_INVALID_ARG` (version/validate failure) or `CC_OK`, never
   `CC_ERR_BAD_SESSION` itself — so on *this* opcode, seeing
   `CC_ERR_BAD_SESSION` really can only come from the dispatcher not
   recognizing the opcode at all (an older `cc_pd`). I'm fairly confident in
   this, but it's an inference from reading `cc_dispatch`'s structure, not
   something I observed by actually connecting to an old `cc_pd` binary.
3. On failure, `useAgentOS` nulls out `authority` entirely rather than
   keeping the last good snapshot with a "stale" marker. This is the more
   conservative, honest choice given the task's emphasis on never showing
   something that could be mistaken for current real data, but it does mean
   a single flaky poll makes the whole card grid disappear and reappear.
   I considered this a reasonable tradeoff, not an oversight.

## Commit

Not yet committed — leaving that to the caller per instructions to report
status back rather than assume commit authority beyond what was asked.
