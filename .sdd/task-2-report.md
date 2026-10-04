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
