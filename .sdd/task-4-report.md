# Task 4 report — drift guard

## What changed

- `src-tauri/src/cc_ipc.rs`: added a `drift_guard_against_agentos_source` test (and
  supporting parsing helpers `find_agentos_src`, `parse_c_define`, `parse_enum_value`,
  `parse_int_token`), all inside the existing `#[cfg(test)] mod tests`. No production code
  changed, no new crate dependency, no `build.rs`.
- `README.md`: new "Keeping the re-declared constants honest" section — how to run the
  guard, what it covers, how to tell a skip from a pass, and the CI conclusion below.

The test resolves an agentOS checkout at **test run time only** (`$AGENTOS_SRC`, else the
sibling `../agentos` next to this repo), reads the relevant `.h` files as plain text, and
hand-parses `#define`/`enum` values with no new dependency (no `regex` crate, just
`str::lines()`/`split_whitespace()`). It checks, against the live agentOS tree:

- all 27 `MSG_CC_*` opcodes in `kernel/agentos-root-task/include/agentos.h`
- `CC_CONNECTION_MAGIC`, `CC_CONNECTION_VERSION`, `CC_OK`, `CC_ERR_NOT_PERMITTED`, and the
  request/reply/greeting wire frame sizes (derived from `CC_MAX_CMD_BYTES`/
  `CC_MAX_RESP_BYTES`), from `cc_contract.h`
- `CC_OPERATOR_TOKEN_BYTES`, from `cc_operator_credential.h`
- the authority snapshot layout — `AOS_AUTHORITY_VERSION`, `AOS_AUTHORITY_NAME_LEN`,
  `AOS_AUTHORITY_KIND_COUNT`, `AOS_AUTHORITY_MAX_PDS`, and the row stride **computed from
  those field widths**, not hardcoded — from `platform/include/platform/authority.h`

If no tree is found, the test returns early after an `eprintln!` banner — it never silently
passes as "verified."

## The three-part demonstration

### 1. Baseline pass (tree present, via sibling `../agentos`)

```
$ cargo test drift_guard -- --nocapture
running 1 test

*** DRIFT GUARD: comparing against agentOS source at /Users/jkh/Src/agentos_gui/src-tauri/../../agentos ***

*** DRIFT GUARD: 27 MSG_CC_* opcodes + handshake + authority layout constants verified against /Users/jkh/Src/agentos_gui/src-tauri/../../agentos ***

test cc_ipc::tests::drift_guard_against_agentos_source ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 16 filtered out; finished in 0.01s
```

### 2. Deliberate break: `MSG_CC_CONNECTION_SYNC` changed from `0x261F` to `0x2620`

```
$ sed -i 's/MSG_CC_CONNECTION_SYNC: u32 = 0x261F/MSG_CC_CONNECTION_SYNC: u32 = 0x2620/' src/cc_ipc.rs
$ cargo test drift_guard -- --nocapture
running 1 test

*** DRIFT GUARD: comparing against agentOS source at /Users/jkh/Src/agentos_gui/src-tauri/../../agentos ***

thread 'cc_ipc::tests::drift_guard_against_agentos_source' panicked at src/cc_ipc.rs:1779:13:
assertion `left == right` failed: DRIFT GUARD: MSG_CC_CONNECTION_SYNC = 0x2620 in this repo but 0x261f in agentos.h -- re-declared opcode has drifted
  left: 9760
 right: 9759
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
test cc_ipc::tests::drift_guard_against_agentos_source ... FAILED

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 16 filtered out; finished in 0.01s
error: test failed, to rerun pass `--lib`
```

Note this also incidentally fails `sync_frame_echoes_greeting_and_carries_credential` (an
existing Task-1 test hardcodes `0x261F` as the expected opcode) — two independent tests
catching the same injected drift from different angles, which is the point.

### 3. Restored, clean rebuild

```
$ git checkout -- src/cc_ipc.rs   # (done via restoring the sed'd line + cargo clean -p agentos-gui to rule out stale incremental artifacts)
$ cargo test
running 17 tests
test cc_ipc::tests::credential_hex_round_trips ... ok
test cc_ipc::tests::dev_credential_is_well_formed ... ok
test cc_ipc::tests::name_truncates_at_the_recorded_nul_without_assuming_a_c_string ... ok
test cc_ipc::tests::parses_root_sentinel_and_a_named_domain ... ok
test cc_ipc::tests::rejects_a_buffer_truncated_before_its_declared_rows ... ok
test cc_ipc::tests::rejects_an_unknown_version_before_indexing_anything ... ok
test cc_ipc::tests::rejects_pd_count_above_the_abi_maximum_before_indexing_anything ... ok
test cc_ipc::tests::sync_frame_echoes_greeting_and_carries_credential ... ok
test commands::sock_path_tests::accepts_a_dot_slash_prefixed_variant_of_the_default ... ok
test cc_ipc::tests::sync_frame_tracks_generation_changes_across_reconnects ... ok
test commands::sock_path_tests::accepts_the_cc_pd_sock_env_override ... ok
test commands::sock_path_tests::accepts_the_current_resolved_default ... ok
test commands::sock_path_tests::rejects_an_arbitrary_unix_socket_path ... ok
test commands::sock_path_tests::rejects_an_empty_path ... ok
test cc_ipc::tests::drift_guard_against_agentos_source ... ok

test result: ok. 17 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
```

(Note: one restore round-trip via `mv backup`/`sed -i.bak` left the content byte-identical but
with an mtime cargo's incremental compiler apparently didn't notice, producing one stale
failing run using the cached binary with the broken opcode baked in. `cargo clean -p
agentos-gui` plus a fresh `cargo test` confirmed the restored source is correct and the full
suite is green — the 17/17 output above is from that clean rebuild. `git diff --stat` at the
end also shows only the intended additive change to `cc_ipc.rs`, confirming no stray edits.)

### Skip path (tree absent / misconfigured)

```
$ AGENTOS_SRC=/tmp/nonexistent-agentos-$$ cargo test drift_guard -- --nocapture
running 1 test

*** DRIFT GUARD SKIPPED: agentOS source tree not found. ***
Checked $AGENTOS_SRC and the sibling '../agentos' checkout. This test did NOT verify this repo's re-declared constants against anything this run -- it is a skip, not a pass. Clone agentOS as a sibling of this repo, or set AGENTOS_SRC=/path/to/agentos, to exercise it. See README.md, 'Keeping the re-declared constants honest'.

test cc_ipc::tests::drift_guard_against_agentos_source ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 16 filtered out; finished in 0.00s
```

The `... ok` line is identical in shape to a real pass — that is the whole hazard this task
is about. The distinguishing signal is the banner text, visible with `--nocapture`, which is
why `--nocapture` usage is called out explicitly in `README.md`.

## Verification commands, full output

### `cargo test` (under `src-tauri/`)

```
running 17 tests
test cc_ipc::tests::malformed_credential_hex_is_rejected_not_silently_defaulted ... ok
test cc_ipc::tests::name_truncates_at_the_recorded_nul_without_assuming_a_c_string ... ok
test cc_ipc::tests::credential_hex_round_trips ... ok
test cc_ipc::tests::dev_credential_is_well_formed ... ok
test cc_ipc::tests::an_unrecognized_opcode_status_is_reported_as_unsupported_not_not_permitted ... ok
test cc_ipc::tests::parses_root_sentinel_and_a_named_domain ... ok
test cc_ipc::tests::rejects_a_buffer_truncated_before_its_declared_rows ... ok
test cc_ipc::tests::rejects_pd_count_above_the_abi_maximum_before_indexing_anything ... ok
test cc_ipc::tests::rejects_an_unknown_version_before_indexing_anything ... ok
test cc_ipc::tests::sync_frame_echoes_greeting_and_carries_credential ... ok
test cc_ipc::tests::sync_frame_tracks_generation_changes_across_reconnects ... ok
test commands::sock_path_tests::accepts_a_dot_slash_prefixed_variant_of_the_default ... ok
test commands::sock_path_tests::accepts_the_cc_pd_sock_env_override ... ok
test commands::sock_path_tests::accepts_the_current_resolved_default ... ok
test commands::sock_path_tests::rejects_an_arbitrary_unix_socket_path ... ok
test commands::sock_path_tests::rejects_an_empty_path ... ok
test cc_ipc::tests::drift_guard_against_agentos_source ... ok

test result: ok. 17 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
```
(`src/main.rs` unittests: 0 tests, ok. Doc-tests: 0 tests, ok.)

### `npm run check`

```
> agentos-gui@0.1.0 check
> tsc --noEmit
```
(no output, exit 0 — no type errors)

### Playwright suite

```
104 passed (11.7s)
```
All 104 tests green, none skipped or modified.

## Conclusion on CI

This repo's CI does not check out agentOS as a sibling, and this task deliberately does not
add that (a `build.rs`/path dependency on the agentOS tree, or a CI step that fetches it as a
hard prerequisite, would reintroduce exactly the coupling the re-declaration is meant to
avoid, and was explicitly out of scope — "do not add a build dependency on the agentOS
tree"). **The practical consequence is that `drift_guard_against_agentos_source` will skip
in this repo's CI today**, exactly as it does for any contributor working without a local
agentOS checkout. It is currently a local-dev / contributor-facing guard: anyone with both
repos cloned as siblings (which is the agentOS-documented layout per its own `CLAUDE.md`
naming `../agentos_gui` as the sanctioned consumer) gets real protection the moment they run
`cargo test`, without that protection ever blocking anyone who doesn't.

If stronger protection is wanted — the guard actually gating CI, not just local runs —
that's a separate, explicit decision: add a CI job that checks out `agentos` next to this
repo (or sets `AGENTOS_SRC` to a checkout it fetches), and have that job treat the "DRIFT
GUARD SKIPPED" banner as a failure (e.g. grep `cargo test -- --nocapture` output for the
skip banner and fail the step if found). I did not make that change myself: it's a workflow
addition outside `src-tauri/`, and silently deciding CI topology that then starts failing
builds on everyone's PRs was not part of this task's green-is-green scope. README.md
documents that choice explicitly in "Keeping the re-declared constants honest" > CI.

## Things that worried me

- **The hand-rolled C `#define`/`enum` parser is intentionally naive** — exact-token
  matching for `#define`, prefix matching for enum members, no handling of multi-line
  macros or conditional compilation (`#ifdef`). agentOS's headers are consistent enough
  today for this to work correctly (verified against real output above), but a header
  reformatted to break these assumptions (e.g. a macro split across lines, or a differently
  styled enum) would make the relevant `parse_c_define`/`parse_enum_value` call return
  `None`, and the test would `.expect(...)`-panic with a message naming the exact constant
  it couldn't find — a loud failure, not a silent pass, so the failure mode stays honest
  even if the parser's assumptions eventually don't match the header style. I did not pull
  in a real C preprocessor/parser crate to avoid adding dependencies for what the task asks
  of a test, not production code.
- **The `--nocapture` dependency for distinguishing skip from pass** is the sharpest edge of
  this task's requirement: by default, Rust's test harness shows "ok" identically whether
  the test verified 27 opcodes or verified nothing. I've made the skip condition as loud as
  I reasonably can within the constraint that we must not fail outright when the tree is
  absent (that was explicitly ruled out — "skip... not pass silently" implies "don't fail
  either"), and documented the distinguishing signal clearly in the README, but a reviewer
  running bare `cargo test` without reading the README will still see a wall of green either
  way. This is inherent to "skip-not-fail" semantics in `libtest`, not a gap I could close
  without either (a) making the test `#[ignore]`-conditionally at compile time (impossible —
  tree presence is a runtime fact) or (b) failing outright when absent (explicitly
  prohibited by the brief).
- **`AOS_AUTHORITY_ROOT_PD_INDEX` (`0xFFFFFFFF`) and `CC_ERR_NOT_PERMITTED`'s exact numeric
  value are not themselves `#define`s in the agentOS headers in the same simple style for
  everything** — `CC_OK`/`CC_ERR_NOT_PERMITTED` are `enum cc_error` members, which needed a
  separate parser (`parse_enum_value`) from the `#define` one. I verified both forms work
  against the real source rather than assuming one style covered everything.

---

# Fix round 1 — give the guard a reason to ever run

## The gap that was found

The coordinator checked the premise behind one of my own disclosed concerns and found it
understated: I had written "this repo's CI does not currently check out agentOS, so the
guard will skip there," implying a CI existed that merely didn't check out the tree. **This
repo has no CI at all** — no `.github/workflows` directory, confirmed by `ls`/`find` before
making any change. Combined with the other disclosed concern (a bare `cargo test` reports
`ok` identically for a skip and a real pass), the conclusion is correct and sharper than what
I wrote: as shipped in the first round, the guard would not have caught any of the three
failures that motivated this task, because nothing was ever going to run it automatically.
The four-month outage happened because no automation existed, not because no test existed —
adding a test to a repo with no CI doesn't change that.

## What changed in this round

1. **`src-tauri/src/cc_ipc.rs`** — `drift_guard_against_agentos_source` now reads
   `AGENTOS_DRIFT_GUARD_REQUIRED`. When unset (or not `"1"`), behavior is unchanged: a
   missing tree skips with the same banner as before. When set to `"1"` and the tree is
   missing, the same banner prints and then an `assert!` panics with a message naming the
   flag and pointing at the checkout step — a hard test failure, not a skip. The doc comment
   above the test was updated to describe both modes.

2. **`.github/workflows/ci.yml`** (new) — a single `test` job on `ubuntu-latest` that:
   - checks out this repo at `path: agentos_gui` and `jordanhubbard/agentos` at
     `path: agentos` (siblings under `$GITHUB_WORKSPACE`)
   - installs Node 20, a stable Rust toolchain, and the Tauri Linux build deps
     (`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev` — needed
     for `cargo test` to even *compile* the `src-tauri` crate on Linux, per this repo's own
     documented Prerequisites)
   - runs `npm ci`, `npm run check`, installs Playwright's Chromium, runs `npm run test`
   - runs `cargo test` under `src-tauri/` with `AGENTOS_SRC=$GITHUB_WORKSPACE/agentos` and
     `AGENTOS_DRIFT_GUARD_REQUIRED=1`
   - deliberately does **not** build or boot agentOS — only its source tree is checked out,
     for the drift guard to read headers from; building/booting needs the qualified seL4 SDK
     and was explicitly out of scope

3. **`README.md`** — rewrote "Telling a skip from a pass" into "Two modes: optional locally,
   required in CI," documenting `AGENTOS_DRIFT_GUARD_REQUIRED=1`, and rewrote "CI" to
   describe the actual workflow (what it runs, why it skips building agentOS, and what it
   still doesn't cover).

## Verification

### 1. `AGENTOS_SRC=/Users/jkh/Src/agentos`, `AGENTOS_DRIFT_GUARD_REQUIRED=1` — must pass

```
$ AGENTOS_SRC=/Users/jkh/Src/agentos AGENTOS_DRIFT_GUARD_REQUIRED=1 cargo test drift_guard -- --nocapture
running 1 test

*** DRIFT GUARD: comparing against agentOS source at /Users/jkh/Src/agentos ***

*** DRIFT GUARD: 27 MSG_CC_* opcodes + handshake + authority layout constants verified against /Users/jkh/Src/agentos ***

test cc_ipc::tests::drift_guard_against_agentos_source ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 16 filtered out; finished in 0.01s
```

### 2. `AGENTOS_SRC=/tmp/nonexistent-agentos-<pid>`, `AGENTOS_DRIFT_GUARD_REQUIRED=1` — must FAIL

```
$ AGENTOS_SRC=/tmp/nonexistent-agentos-$$ AGENTOS_DRIFT_GUARD_REQUIRED=1 cargo test drift_guard -- --nocapture
running 1 test

*** DRIFT GUARD SKIPPED: agentOS source tree not found. ***
Checked $AGENTOS_SRC and the sibling '../agentos' checkout. This test did NOT verify this repo's re-declared constants against anything this run -- it is a skip, not a pass. Clone agentOS as a sibling of this repo, or set AGENTOS_SRC=/path/to/agentos, to exercise it. See README.md, 'Keeping the re-declared constants honest'.

thread 'cc_ipc::tests::drift_guard_against_agentos_source' panicked at src/cc_ipc.rs:1738:13:
DRIFT GUARD: AGENTOS_DRIFT_GUARD_REQUIRED=1 but no agentOS source tree was found (checked $AGENTOS_SRC and the sibling '../agentos'). In CI this must be a hard failure, not a skip -- a skip that looks like a pass is exactly the ambiguity this flag exists to remove. Check the sibling checkout step (or AGENTOS_SRC) in the workflow.
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
test cc_ipc::tests::drift_guard_against_agentos_source ... FAILED

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 16 filtered out; finished in 0.00s
error: test failed, to rerun pass `--lib`
```

### 3. No required flag, tree pointed at a nonexistent path — must SKIP (not fail)

```
$ AGENTOS_SRC=/tmp/nonexistent-agentos-$$ cargo test drift_guard -- --nocapture
running 1 test

*** DRIFT GUARD SKIPPED: agentOS source tree not found. ***
Checked $AGENTOS_SRC and the sibling '../agentos' checkout. This test did NOT verify this repo's re-declared constants against anything this run -- it is a skip, not a pass. Clone agentOS as a sibling of this repo, or set AGENTOS_SRC=/path/to/agentos, to exercise it. See README.md, 'Keeping the re-declared constants honest'.

test cc_ipc::tests::drift_guard_against_agentos_source ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 16 filtered out; finished in 0.00s
```

### `npm run check`

```
> agentos-gui@0.1.0 check
> tsc --noEmit
```
No output, exit 0.

### Playwright suite

```
104 passed (11.6s)
```
All 104 tests green, unchanged.

### Full `cargo test` (default env, no override — sibling `../agentos` auto-detected)

```
running 17 tests
...
test cc_ipc::tests::drift_guard_against_agentos_source ... ok

test result: ok. 17 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
```

## On the workflow YAML

I validated `.github/workflows/ci.yml` parses as YAML (`python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` succeeds; PyYAML 1.1 parses the bare `on:` key as the boolean `True` under the hood, which is a well-known YAML 1.1 quirk and not a workflow defect — GitHub Actions' own schema parses `on:` as the trigger key correctly). **I have not executed this workflow** — there is no way to run GitHub Actions locally in this environment, and I am not claiming it has run or passed. Everything else in this report (the four `cargo test` scenarios, `npm run check`, Playwright) was actually executed locally, on this machine, with real output pasted above.

Residual risk in the unexecuted workflow I'd flag for a human to confirm on first real run:
- Whether `jordanhubbard/agentos` is reachable by `actions/checkout` from this runner (public repo access, no auth configured).
- Whether the pinned `libwebkit2gtk-4.1-dev` package name is still current on whatever `ubuntu-latest` resolves to at the time it runs (Ubuntu's webkit2gtk packaging has changed version suffixes before).
- Whether `npm run test`'s Playwright `webServer` (`npx vite`) starts cleanly in the CI sandbox network-wise; `reuseExistingServer: !process.env.CI` means CI always launches it fresh, which should be fine but is untested here.

## Explicit follow-up (not in scope here)

A job that boots agentOS and exercises the GUI against a live `cc_pd` is the only thing that
would have caught the second of the three motivating failures — the trace calls inside
`Promise.all` in the refresh loop, where one `CC_ERR_NOT_PERMITTED` refusal silently stopped
every panel from updating. That is a runtime interaction between two live processes, not a
constant mismatch; the drift guard added here cannot see it and should not be read as if it
does. Building that job needs the qualified seL4 SDK and a way to boot agentOS headlessly in
CI, which is its own piece of work, explicitly out of scope for this task.
