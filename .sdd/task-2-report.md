# Task 2 report: close the hardening gaps

## Summary

Closed all four gaps named in the brief:

1. Replaced `"csp": null` in `src-tauri/tauri.conf.json` with a restrictive,
   no-wildcard, no-`unsafe-inline` policy.
2. Replaced the unscoped `core:default` grant in
   `src-tauri/capabilities/default.json` with an explicit allowlist of the 28
   `cc_*` commands the UI actually calls (enumerated via `grep -rn "invoke("
   src/`). This required adding ACL generation for the app's own commands via
   `src-tauri/build.rs` (see below — Tauri does not do this for app commands
   by default).
3. Removed `@tauri-apps/plugin-shell` from `package.json` (ran `npm uninstall
   @tauri-apps/plugin-shell`, which also updated `package-lock.json`).
   Confirmed with `grep -rln "plugin-shell" src/ src-tauri/src/` and
   `grep -n "plugin-shell" src-tauri/Cargo.toml src-tauri/src/lib.rs` that
   nothing imported or registered it — it was already fully inert.
4. `cc_connect` in `src-tauri/src/commands.rs` now validates the frontend-
   supplied path against the set of paths the backend itself would resolve
   (`CC_PD_SOCK`, the sibling-repo default from both cwd and exe location,
   `build/cc_pd.sock`, `$HOME/Src/agentos/build/cc_pd.sock`) or the path
   currently held in `AppState.sock_path`. Anything else is rejected with a
   clear error before a socket is ever opened.

## Step 1: Content Security Policy

Chosen policy (`src-tauri/tauri.conf.json`):

```
default-src 'self';
connect-src 'self' ipc: http://ipc.localhost;
script-src 'self';
style-src 'self' https://fonts.googleapis.com;
font-src 'self' https://fonts.gstatic.com;
img-src 'self' data:;
object-src 'none';
base-uri 'self';
frame-ancestors 'none'
```

No `unsafe-inline`, no `unsafe-eval`, no wildcard (`*`) sources anywhere.

What had to be allowed, and why:

- `connect-src ipc: http://ipc.localhost` — this is Tauri v2's own documented
  requirement (see `tauri-utils-2.8.3/src/config.rs` doc comment on
  `HeaderSource`/`csp`): the webview's IPC bridge issues requests against the
  `ipc:` scheme / `http://ipc.localhost`, and without this the window can't
  call any `invoke()` at all, i.e. the whole app breaks. `'self'` alone is
  not enough because in dev mode the document origin is
  `http://localhost:1420` and in the production bundle it's
  `tauri://localhost` — neither IS `ipc://localhost`.
- `style-src https://fonts.googleapis.com` and `font-src
  https://fonts.gstatic.com` — `src/styles.css` does
  `@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono...')`
  for the JetBrains Mono / Inter webfonts used throughout the UI. These are
  named, non-wildcard origins restricted to exactly what's needed (the CSS
  endpoint and the font-file CDN); I did not self-host the fonts to avoid a
  larger, out-of-scope change to `src/styles.css`/asset pipeline. This is a
  privacy/availability consideration (the app phones out to Google on first
  paint), not a script-injection one — those two origins cannot execute
  script or drive the CC socket.
- `img-src data:` — defensive allowance for any inline SVG/data-URI assets;
  does not affect `script-src`/`connect-src`.

No other exceptions were required. `script-src 'self'` with no
`unsafe-inline`/`unsafe-eval` holds for both the dev server and the
production build.

### Verification

- `npm run build` succeeded, producing a working release bundle
  (`src-tauri/target/release/bundle/macos/agentOS GUI.app` and a `.dmg`).
- I launched the built app directly
  (`.../agentOS GUI.app/Contents/MacOS/agentos-gui`) with
  `AGENTOS_GUI_AUTOCONNECT=0` and watched both the process's stdout/stderr
  and `log show --predicate 'process == "agentos-gui"'` (macOS unified
  logging, which is where WebKit reports CSP violations as
  `ContentSecurityPolicy`/"Refused to..." messages). I saw:
  - `WebPageProxy::didGeneratePageLoadTiming: firstVisualLayout=0.064
    firstMeaningfulPaint=0.108 domContentLoaded=0.059 loadEvent=0.009
    subresourcesFinished=0.072` — the page loaded and painted content.
  - Zero occurrences of `ContentSecurityPolicy`, "Refused to", or "blocked"
    in the log for that process across the run.
  - No crash; the process stayed alive and resident until I killed it.
  - **Caveat:** this sandbox has no attached interactive display —
    `screencapture` returned an all-black image, so I could not visually
    confirm pixel-level rendering (fonts loading, layout correctness). The
    WebKit page-load-timing event (non-zero `firstMeaningfulPaint`) and the
    absence of any CSP-violation log lines are the strongest evidence
    available in this environment that the policy does not break asset
    loading; I was not able to do a full interactive click-through of the
    live Tauri window.
- The Playwright suite (93/93) **does not exercise this CSP** — Playwright
  launches a plain Chromium pointed at `http://localhost:1420` directly via
  `npx vite` (see `playwright.config.ts`), bypassing the Tauri runtime
  entirely, and the Tauri CSP meta/header injection only happens when Tauri
  itself serves the page. So Playwright's 93/93 pass is necessary but not
  sufficient evidence for the CSP; the app-bundle launch above is the actual
  CSP check. I'm flagging this explicitly per the task's instruction to say
  so if Playwright doesn't cover an asset-loading path — it doesn't, here.

## Step 2: Scope the Tauri capability set

Commands invoked by the UI, found via `grep -rn "invoke(" src/` (all calls
live in `src/hooks/useAgentOS.ts`, which is the sole file that imports
`invoke` from `@tauri-apps/api/core`):

```
cc_get_sock_path, cc_should_autoconnect, cc_connect, cc_disconnect,
cc_list_guests, cc_list_devices, cc_list_polecats, cc_list_sessions,
cc_session_status, cc_traffic_events, cc_trace_query, cc_trace_dump,
cc_guest_status, cc_log_stream, cc_snapshot, cc_restore, cc_suspend_guest,
cc_resume_guest, cc_destroy_guest, cc_send_input, cc_device_status,
cc_create_guest, cc_session_send, cc_session_recv, cc_attach_framebuffer,
cc_fault_inject, cc_trace_start, cc_trace_stop
```

That's 28 of the 29 registered commands. `cc_is_connected` is registered in
`src-tauri/src/lib.rs` but never invoked anywhere in `src/` — it is **not**
granted in the new capability file, so calling it from the webview will now
be rejected by Tauri's ACL (it's effectively dead code; I left it registered
since removing it wasn't in scope, but it's no longer reachable from the
frontend).

**Mechanism:** Tauri v2 only enforces ACL on an app's own (non-plugin)
commands if the app defines its own permission manifest
(`has_app_manifest()` in `tauri::webview::handle_ipc_message` — confirmed by
reading `tauri-2.10.3/src/webview/mod.rs`). This project's `build.rs` never
did that, so `core:default` was in practice decorative for the `cc_*`
surface — **every one of the 29 commands was reachable regardless of the
capability file**, because there was no app ACL manifest for Tauri to check
against. I fixed this at the source by changing `src-tauri/build.rs` to call
`tauri_build::try_build` with `AppManifest::new().commands(&[...])` listing
all 29 registered commands, which autogenerates `allow-<command>` /
`deny-<command>` permissions (commands with underscores become
hyphen-identifiers, e.g. `cc_connect` → `allow-cc-connect`; confirmed by
reading `tauri-build-2.5.6/src/acl.rs` and `tauri-utils-2.8.3/src/acl/
build.rs`, and by provoking a real ACL-identifier-parse error to check the
exact naming convention before committing to it). `capabilities/default.json`
now lists only the 28 `allow-cc-*` permissions for commands the UI actually
calls — no `core:default`.

The generated permission TOML files land in
`src-tauri/permissions/autogenerated/` (build output, not hand-maintained); I
added that path to `.gitignore` alongside the existing `src-tauri/gen/`
entry, consistent with how this repo already treats other Tauri build
artifacts.

### Verification

- `cargo build` (debug) and `npm run build` (full release bundle) both
  succeed with the scoped capability set — confirms the ACL identifiers
  resolve correctly at build time.
- Playwright (93/93) passed. Caveat: Playwright mocks
  `window.__TAURI_INTERNALS__.invoke` entirely (see
  `tests/helpers/tauri.ts`) and never reaches the real Rust IPC/ACL layer, so
  it cannot by itself prove the capability scoping works at runtime — it only
  proves the frontend still calls the right command names with the right
  arguments. The real proof that scoping works is the build-time ACL
  resolution (`cargo build` fails loudly if a listed permission identifier
  doesn't exist) plus manual review that every command in the Step-2
  enumeration above has a corresponding `allow-cc-*` entry in
  `capabilities/default.json` (it does — 28 for 28).

## Step 3: Remove `@tauri-apps/plugin-shell`

Removed from `package.json` via `npm uninstall @tauri-apps/plugin-shell`
(updated `package-lock.json` accordingly). Confirmed before removal that it
was never imported in `src/` and never registered in `src-tauri/src/lib.rs`
or referenced in `src-tauri/Cargo.toml` — it was dependency-only dead weight.

## Step 4: Validate the socket path in Rust

`src-tauri/src/commands.rs` gained `allowed_sock_paths()` (a superset of
every candidate `default_sock_path()` can resolve to — not just the first
match) and `validate_sock_path(path, state)`, which accepts a frontend-
supplied path only if it equals the backend's current `AppState.sock_path`
or one of the `allowed_sock_paths()` candidates. `cc_connect` now calls this
before doing anything else, and only ever opens the validated path.

```rust
fn validate_sock_path(path: &str, state: &AppState) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("socket path must not be empty".to_string());
    }
    let current_default = state.sock_path.lock()...clone();
    if trimmed == current_default || allowed_sock_paths().iter().any(|p| p == trimmed) {
        return Ok(trimmed.to_string());
    }
    Err(format!(
        "socket path {trimmed:?} is not a recognized agentOS control-plane socket location \
         (expected the CC_PD_SOCK value, the sibling agentos build directory, or the resolved default)"
    ))
}
```

**Behavior change worth flagging explicitly:** `ConnectDialog.tsx`'s free-text
input (and its `localStorage`-backed recent-paths history) still lets an
operator *type* any string and click Connect — I did not touch any `.tsx`
file, per the brief's file list for this task, and the Playwright suite
confirms the UI still accepts and submits arbitrary typed text
(`tests/connect.spec.ts`, `tests/recent_paths.spec.ts` all still pass,
because they mock IPC and never reach real Rust validation). But the **real**
Rust backend will now reject a manually typed path that isn't one of the
resolved candidates, with the clear error above, instead of silently trying
to open it. This is a real, deliberate behavior restriction: an operator
pointing the GUI at a genuinely nonstandard socket location must now use the
already-documented `CC_PD_SOCK` environment variable (`README.md`/`AGENTS.md`
both already document `make run CC_PD_SOCK=/path/to/cc_pd.sock` as the
supported way to do this) rather than typing it into the dialog. I did not
find a way to let the Rust backend distinguish "a human typed this into the
real input field" from "a script called `invoke('cc_connect', {path:
...})`  directly" — both arrive as an identical IPC call with an identical
string argument, so the only mechanistically enforceable control available
at the Rust layer is restricting to backend-resolved candidates. I'm
flagging this as a UX regression for anyone who was relying on typing a
fully custom path in the dialog; they now need to relaunch with `CC_PD_SOCK`
set instead. This matches the brief's literal requirement ("the frontend
must not be able to point the backend at an arbitrary Unix socket on the
machine") and I believe it's the correct trade-off given that requirement,
but it is a functional change beyond pure hardening and I want it called out
explicitly rather than discovered later.

Added four Rust unit tests (`commands::sock_path_tests`) covering: accepting
the current resolved default, accepting a `CC_PD_SOCK`-overridden path,
rejecting an arbitrary unrelated socket path, and rejecting an empty path.

## Verification — real output

### `npm run check`

```
> agentos-gui@0.1.0 check
> tsc --noEmit
```
(no output — clean)

### `npm test` (Playwright, 93 tests)

```
Running 93 tests using 5 workers
...
93 passed (14.6s)
```

### `cargo test` (under `src-tauri/`)

```
running 9 tests
test cc_ipc::tests::dev_credential_is_well_formed ... ok
test cc_ipc::tests::sync_frame_tracks_generation_changes_across_reconnects ... ok
test cc_ipc::tests::credential_hex_round_trips ... ok
test cc_ipc::tests::malformed_credential_hex_is_rejected_not_silently_defaulted ... ok
test cc_ipc::tests::sync_frame_echoes_greeting_and_carries_credential ... ok
test commands::sock_path_tests::accepts_the_current_resolved_default ... ok
test commands::sock_path_tests::rejects_an_empty_path ... ok
test commands::sock_path_tests::accepts_the_cc_pd_sock_env_override ... ok
test commands::sock_path_tests::rejects_an_arbitrary_unix_socket_path ... ok

test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```
(the 5 `cc_ipc::tests` are from Task 1's reconnect work, not this task; included for completeness since `cargo test` runs the whole crate)

### Build

- `cargo build` (debug, under `src-tauri/`): `Finished \`dev\` profile [unoptimized + debuginfo] target(s)`
- `npm run build` (full release + bundle): `Finished \`release\` profile [optimized] target(s) in 1m 09s`, produced `agentOS GUI.app` and `agentOS GUI_0.1.0_aarch64.dmg`.

## Things that worried me

1. **CSP visual verification is incomplete.** This sandbox has no usable
   display (`screencapture` returns solid black), so I could not click
   through the live app window to confirm every pixel renders as expected
   under the new CSP. I relied on `log show` (no CSP-violation log lines)
   and WebKit's own page-load-timing telemetry (non-zero
   `firstMeaningfulPaint`) as the best available evidence short of that. If
   there's a path to run this in an environment with a real display, I'd
   recommend doing a manual click-through before shipping.
2. **Google Fonts dependency survives the CSP.** `style-src`/`font-src` both
   carry a named exception for `fonts.googleapis.com`/`fonts.gstatic.com`.
   This is a narrow, non-wildcard allowance, but it is still a live network
   dependency on first paint, which is in tension with the "reduce what
   external code/network can do inside this window" spirit of the task. The
   clean fix is to self-host the two font families and drop these two CSP
   exceptions entirely; I did not do that here because it touches
   `src/styles.css`/the asset pipeline, which is outside the four files this
   task scoped (`tauri.conf.json`, `capabilities/default.json`,
   `package.json`, `commands.rs`). Flagging it as a good follow-up.
3. **The `cc_connect` free-text path restriction is a real UX regression**
   for anyone using a nonstandard socket location via the dialog's recent-
   paths feature instead of `CC_PD_SOCK` — see Step 4 above. I believe it's
   the right trade-off given the brief's explicit wording, but it's worth a
   second pair of eyes since it changes documented-feeling behavior
   (`ConnectDialog`'s history/typed-path UI) even though it's not literally
   documented as supporting arbitrary paths anywhere.
4. **`core:default` is fully gone**, including whatever baseline Tauri
   plumbing it covered beyond our own commands (window/app/event/etc. core
   plugin permissions). I checked `grep -rn "@tauri-apps/api" src/` and
   confirmed only `invoke` from `@tauri-apps/api/core` is imported anywhere
   in the frontend — no `@tauri-apps/api/event`, `/window`, `/app`, etc. — so
   nothing in the current UI should need those. But if a future UI change
   needs, e.g., window-close-confirmation via `@tauri-apps/api/window`, it
   will need an explicit `core:window:allow-*` permission added; it won't
   "just work" anymore the way it silently did under `core:default`.

---

# Fix round 1 (post-review)

Review verdict: Spec COMPLIANT but NOT APPROVED — one Critical, one Important,
two Minor, plus a "verify and report" item on xterm/CSP. All addressed below.
`npm run check`, the full Playwright suite, `cargo test`, and a release build
all pass — real output at the end of this section.

## CRITICAL: a correctly-hardened cc_pd bricked the dashboard

**Root cause.** agentOS's T1 work added an operator authority envelope to
`cc_pd` that deliberately refuses snapshot, restore, fault-injection and
trace with `CC_ERR_NOT_PERMITTED` (snapshot reads guest RAM in full and is
an exfiltration primitive; fault injection is an attack tool; trace is debug
surface). `useAgentOS.ts`'s `refresh()` had `cc_trace_query`/`cc_trace_dump`
inside the same `Promise.all` as guests/devices/polecats/sessions/traffic.
`Promise.all` rejects wholesale on the first rejection, so the moment a
correctly-hardened `cc_pd` refused trace, **every** refresh cycle failed,
permanently, behind one generic header error — guests, devices, polecats,
sessions and traffic all stopped updating. The app looked broken; the actual
cause was a security policy on the other side of the socket that this client
had no way to distinguish from a transport fault.

**Fix, two parts, both implemented:**

1. **`src/hooks/useAgentOS.ts`** — `cc_trace_query` and `cc_trace_dump` are
   now fetched in their own `Promise.all`, separate from the main one, with
   `.catch()` on each (same pattern already used for the traffic re-fetch in
   `fetchLogs()`). A refused trace call can no longer take the rest of a
   refresh cycle down with it. New state field `traceNotPermitted: string |
   null` carries the reason when cc_pd refuses it.

2. **Typed `NotPermitted` distinction, end to end:**
   - `src-tauri/src/cc_ipc.rs`: added `pub const CC_ERR_NOT_PERMITTED: u32 =
     11` and a `status_err(context, ok)` helper used by `snapshot`,
     `restore`, `fault_inject`, `trace_start`, `trace_stop`, `trace_query`,
     and `trace_dump` (the exact four categories the envelope restricts).
     It reports a `CC_ERR_NOT_PERMITTED` reply with
     `io::ErrorKind::PermissionDenied` — a real, typed distinction, not a
     string convention — so callers can tell "cc_pd refused this on
     purpose" apart from `io::ErrorKind::Other` for every other non-OK
     status, without parsing message text.
   - `src-tauri/src/commands.rs`: added `map_cc_error(e: io::Error) ->
     String`, used by the seven corresponding Tauri commands. It checks
     `e.kind() == PermissionDenied` and prefixes the string crossing the IPC
     boundary with `NOT_PERMITTED: ` so the frontend can detect it
     mechanically (Tauri commands only carry `String` errors across IPC, so
     this is the boundary where the Rust-typed distinction has to become a
     frontend-detectable signal).
   - `src/lib/ccErrors.ts` (new): `notPermittedReason(error)` strips that
     prefix and returns the reason, or `null` if the error wasn't a refusal.
     Shared by `useAgentOS.ts`, `GuestCard.tsx`, and `ApiPanel.tsx` so the
     detection logic lives in exactly one place.

**Per the instruction not to hide the affected controls** (hiding would
hardcode a policy this client cannot observe — the envelope is defined by
the running `cc_pd`, not by the GUI): on a `NotPermitted` response the
specific control is **disabled** with a visible, persistent message naming
the reason, rather than removed:
- `GuestCard.tsx`: Snapshot/Restore buttons disable individually and show
  "refused by the operator authority envelope: …" (amber, with a
  `ShieldOff` icon) the first time cc_pd refuses either.
- `ApiPanel.tsx`: Inject, and the four TraceRecorder buttons (Start / Stop /
  Query / Dump), do the same — fault-inject and trace are Important
  (user-initiated, fail in isolation) per the review, handled with the
  identical mapping as the Critical trace-in-refresh path.

## IMPORTANT: ConnectDialog invited input it would always refuse

`cc_connect` (hardened in the original round) only accepts a
backend-resolved path, but `ConnectDialog.tsx` still offered a free-text
field plus a typed-path history the backend now rejects outright — teaching
operators the app is broken. Fixed:

- Added `cc_allowed_sock_paths` (`src-tauri/src/commands.rs`, registered in
  `lib.rs`/`build.rs`/`capabilities/default.json` the same way as every
  other command in this project): returns the backend's currently active
  default first, followed by every other path `allowed_sock_paths()` would
  accept, deduplicated.
- `ConnectDialog.tsx` redesigned: the socket-path field is now `readOnly`
  and always shows a backend-resolved path — nothing the operator types is
  ever sent. When the backend reports more than one legitimate candidate, a
  "Known locations" `<select>` lets the operator pick among them (replacing
  the old free-text + `localStorage` history). Help text documents the
  supported override: "relaunch with `CC_PD_SOCK=/path/to/cc_pd.sock`" —
  this was already the documented mechanism in `README.md`/`AGENTS.md`, just
  not mentioned in the dialog itself.
- `useAgentOS.ts` fetches `cc_allowed_sock_paths` alongside
  `cc_get_sock_path` on mount and exposes it as `state.sockPathOptions`.

This is a real, intentional UX change: an operator who was relying on typing
an arbitrary custom path into the dialog must now relaunch with `CC_PD_SOCK`
instead. That trade-off was flagged in the original report and is exactly
what this fix follows through on.

**Test impact:** `tests/connect.spec.ts` and `tests/recent_paths.spec.ts`
tested the old free-text/history behavior directly (typing arbitrary paths,
`localStorage` persistence) — behavior that no longer exists by design.
Per the review, I did not delete or weaken coverage; I rewrote both files to
test the replacement feature at equal or greater depth: default display,
read-only enforcement, picker population from `cc_allowed_sock_paths`,
default preselection, picking an alternate and connecting with it, the
CC_PD_SOCK documentation text, Enter-to-connect, and the existing
error-handling paths — all unchanged in spirit, now exercised against the
picker instead of a text field. `tests/helpers/app.ts`'s `connectApp()` was
updated to select from the picker when a non-default path is requested
instead of filling text.

## MINOR: flaky env-var tests

`src-tauri/src/commands.rs`'s `sock_path_tests` module: added a
module-level `static ENV_LOCK: std::sync::Mutex<()>`, held for the duration
of every test that sets/removes `CC_PD_SOCK` or calls `validate_sock_path`
(which reads it indirectly via `allowed_sock_paths()`). Rust's default test
harness runs tests in parallel threads within one process and
`std::env::set_var`/`remove_var` are process-wide, so without this, two
tests touching `CC_PD_SOCK` concurrently could interleave. Verified stable
across three consecutive `cargo test` runs.

## MINOR: `./build/cc_pd.sock` vs `build/cc_pd.sock`

Added `normalize_path_str()` (`src-tauri/src/commands.rs`) — a purely
lexical normalization (collapses `.` and resolves `..` against a preceding
component) used before every path comparison in `validate_sock_path()` and
the new `cc_allowed_sock_paths` dedup. Deliberately **not**
`std::fs::canonicalize`: the whole point of `allowed_sock_paths()` is to
list sockets agentOS *might* create, and `canonicalize` fails outright on a
path that doesn't exist yet (e.g. before `cc_pd` has started). Added a test,
`accepts_a_dot_slash_prefixed_variant_of_the_default`, confirming
`./build/cc_pd.sock` now validates against a `build/cc_pd.sock` default.

## xterm.js vs the CSP — verified, and it was a real casualty

I built the real release bundle and additionally wrote a throwaway
Playwright script (not part of the suite — deleted after use) that served
the built `dist/` via `vite preview`, injected the exact CSP as a `<meta>`
tag (reproducing what Tauri does on Linux; Tauri delivers it as a response
header on macOS/Windows, which is strictly stricter, not looser), mocked
`window.__TAURI_INTERNALS__`, connected, and opened the guest console
(which mounts `@xterm/xterm`), capturing all `console.error` output.

**Result: xterm.js was a real, reproducible casualty.** It calls
`document.createElement("style")` internally (confirmed in
`node_modules/@xterm/xterm/lib/xterm.js`: `this._dimensionsStyle` and
`this._themeStyle`, both `<style>` elements appended to the DOM at runtime
for character-cell measurement and ANSI theme colors) — this is governed by
CSP's `style-src`/`style-src-elem`, not the `style=""` attribute path, and
is unrelated to React's `style={{...}}` prop usage elsewhere in this app
(`AgentPool.tsx`, `TopologyGraph.tsx`), which sets DOM style properties
directly and, confirmed by the same test, triggers **no** CSP violation.
Under the original `style-src 'self' https://fonts.googleapis.com` (no
`unsafe-inline`), the browser logged three `Applying inline style
violates... style-src` errors per console mount and the terminal's
dimension/theme styling never applied.

**Fix:** added `style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com`
as an additional, narrower directive alongside the existing `style-src`
(which still has no `unsafe-inline` and governs the `style=""` attribute
path). Per CSP's directive-precedence rules, `style-src-elem` — when
present — governs `<style>`/`<link rel=stylesheet>` elements specifically
and `style-src` no longer applies to them; `style-src` still fully applies
to the attribute path. I deliberately avoided the alternative of just adding
`unsafe-inline` to the base `style-src` (which would have been silent and
would have reopened the attribute path too, per the instruction not to do
that). Re-ran the same test after the change: zero CSP violations, terminal
style elements applied.

**What this exception actually costs:** a malicious script with any reach
into this webview could now inject its own `<style>` element (e.g. for a
UI-redress/phishing overlay). It cannot inject or execute script
(`script-src 'self'`, untouched), cannot reach a new network origin
(`connect-src`/`default-src`, untouched), and cannot set the `style=""`
attribute directly without `unsafe-inline` on `style-src` itself, which I
did not add. This is a real, narrow relaxation, not a no-op — I'm not
characterizing it as closing nothing, the way the task warns against for
the whole-CSP case — but it is a materially smaller exception than relaxing
`style-src` generally.

**Caveat I could not fully close:** `style-src-elem` is a CSP Level 3
directive. It's supported in Chromium (used for my verification) and
Firefox; WebKit/Safari support landed in Safari 15.4 (macOS 12.3,
March 2022). Tauri's macOS target is WKWebView, so on an OS older than that
the browser would presumably fall back to the base `style-src` (without
`unsafe-inline`) for `<style>` elements too, per the CSP spec's directive-
fallback behavior, and xterm's dynamic styles would be blocked again on
that specific old-OS case. I was not able to verify WebKit's exact fallback
behavior directly in this sandbox (no older macOS/Safari available). This
is a real residual gap and I'm reporting it rather than asserting it's
fully resolved on every platform.

## Verification — real output

### `npm run check`
```
> agentos-gui@0.1.0 check
> tsc --noEmit
```
(clean)

### `cargo test` (run three times to confirm no flake from the env-var fix)
```
running 10 tests
test cc_ipc::tests::malformed_credential_hex_is_rejected_not_silently_defaulted ... ok
test cc_ipc::tests::dev_credential_is_well_formed ... ok
test cc_ipc::tests::sync_frame_tracks_generation_changes_across_reconnects ... ok
test cc_ipc::tests::credential_hex_round_trips ... ok
test commands::sock_path_tests::accepts_the_cc_pd_sock_env_override ... ok
test commands::sock_path_tests::accepts_a_dot_slash_prefixed_variant_of_the_default ... ok
test cc_ipc::tests::sync_frame_echoes_greeting_and_carries_credential ... ok
test commands::sock_path_tests::accepts_the_current_resolved_default ... ok
test commands::sock_path_tests::rejects_an_arbitrary_unix_socket_path ... ok
test commands::sock_path_tests::rejects_an_empty_path ... ok

test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```
Stable across 3 consecutive runs.

### `npm test` (Playwright — 100 tests; 7 new vs. the previous round: 2 refused-control
tests in `guests.spec.ts`, 2 in `api.spec.ts`, 1 refresh-resilience test, plus
net new coverage in the rewritten `connect.spec.ts`/`recent_paths.spec.ts`)
```
Running 100 tests using 5 workers
...
100 passed (11.3s)
```

### Build
- `npm run build` (full release + bundle): succeeded, produced
  `agentOS GUI.app` and `agentOS GUI_0.1.0_aarch64.dmg` with the updated CSP
  baked in.
- Launched the real built app headlessly (`AGENTOS_GUI_AUTOCONNECT=0`) and
  checked `log show --predicate 'process == "agentos-gui"'`: page load
  completed (`firstMeaningfulPaint=0.126`, `subresourcesFinished=0.088`),
  zero CSP-violation log lines, process stayed resident until killed. Same
  caveat as the original report: no interactive display in this sandbox, so
  this is not a substitute for a manual click-through.

## Remaining concerns

- The WebKit/`style-src-elem` fallback gap above (old macOS/Safari).
- Google Fonts remains a named CSP exception and a first-paint network
  dependency — recorded as a non-blocking follow-up per the review, not
  fixed in this round.
- `cc_is_connected` is still registered but ungranted/unused, as in the
  original round — unchanged, not in scope for this round.
