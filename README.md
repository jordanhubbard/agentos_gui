# agentos_gui

Desktop UI for [agentOS](https://github.com/jkh/agentos). Connects to a running agentOS
instance via the CC-PD socket and exposes the full `cc_contract.h` API surface through
a native desktop application.

**Zero kernel headers included.** All protocol constants are re-declared from the published
CC contract spec. The only dependency on the agentOS repo is keeping opcode values in sync
with `agentos.h` when they change. See "Keeping the re-declared constants honest" below for
the test that checks this — the duplication is deliberate, but unchecked duplication is how
this GUI went four months without being able to connect at all (`MSG_CC_CONNECTION_SYNC`
became a mandatory first frame in `cc_pd` on 2026-09-21; this repo's last commit predated it
and nobody noticed until the next person tried to connect).

## Architecture

```
agentos (running in QEMU)
  └─ cc_pd  ──[Unix socket: build/cc_pd.sock]──►  agentos_gui
                                                    ├─ src-tauri/   Rust / Tauri 2
                                                    │   ├─ cc_ipc.rs   wire protocol
                                                    │   └─ lib.rs      Tauri commands
                                                    └─ src/          React / TypeScript
                                                        ├─ hooks/useAgentOS.ts
                                                        └─ components/
```

## Prerequisites

- Rust + Cargo (`rustup`)
- Node.js ≥ 20
- Tauri v2 system deps:
  - macOS: Xcode Command Line Tools
  - Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvk2-dev`

## Getting started

Start agentOS first; its default `make run` boots the local Ubuntu guest and
opens the CC-PD socket at `build/cc_pd.sock`:

```sh
cd /path/to/agentos
make run
```

Then launch the GUI from this repository:

```sh
cd /path/to/agentos_gui
make build
make run             # opens the native app against ../agentos/build/cc_pd.sock
```

`make run` sets `CC_PD_SOCK` to the sibling agentOS socket by default,
enables autoconnect, and talks directly to `cc_pd` at
`../agentos/build/cc_pd.sock`. Override the socket when needed:

```sh
make run CC_PD_SOCK=/path/to/agentos/build/cc_pd.sock
```

For hot-reload development, use:

```sh
make dev
```

## Build

```sh
npm run build        # produces a native .app / .deb / .AppImage in src-tauri/target/
```

## Wire protocol

Request:  `opcode(4) + mr[3](12) + shmem(4096)` = 4112 bytes  
Reply:    `mr[4](16) + shmem(4096)` = 4112 bytes

See `src-tauri/src/cc_ipc.rs` and `cc_contract.h` in the agentOS repo.

The Tauri bridge records a bounded in-memory traffic ring for every CC-PD
request and reply. The Guests view renders that hook as a live topology and
message traffic inspector so protocol failures are visible during OS bring-up.

## Keeping the re-declared constants honest

This repo re-declares agentOS's protocol constants instead of including its headers (see
the top of this file). That separation is deliberate — this is an out-of-tree consumer, not
a build that should depend on agentOS's source tree — but **nothing checked the two copies
stayed in sync**, and the cost has been measured directly: a mandatory new first frame
(`MSG_CC_CONNECTION_SYNC`) broke every connection for four months with no test anywhere
catching it, and a prior task's own brief specified the authority-row layout as
`name[48]`/80-byte rows when the real struct is `name[32]`/60-byte rows — a parser built to
that spec would not have crashed, it would have read counts and names at the wrong offsets
and rendered plausible-looking garbage.

`src-tauri/src/cc_ipc.rs` has a test, `drift_guard_against_agentos_source`, that guards
against this recurring. It does **not** build against the agentOS tree (no `build.rs`
dependency, no path dependency, no vendored header copy) — it locates an agentOS checkout
at test *run* time, parses the authoritative `#define`/`enum` values straight out of its
source, and asserts this repo's re-declared copies still match:

- every `MSG_CC_*` opcode in `kernel/agentos-root-task/include/agentos.h`
- `CC_CONNECTION_MAGIC`, `CC_CONNECTION_VERSION`, `CC_OK`, `CC_ERR_NOT_PERMITTED`, and the
  request/reply/greeting wire frame sizes, from `cc_contract.h`
- `CC_OPERATOR_TOKEN_BYTES`, from `cc_operator_credential.h`
- the authority snapshot layout — `AOS_AUTHORITY_VERSION`, `AOS_AUTHORITY_NAME_LEN`,
  `AOS_AUTHORITY_KIND_COUNT`, `AOS_AUTHORITY_MAX_PDS`, and the row stride computed from
  those field widths (not hardcoded) — from `platform/include/platform/authority.h`

### Running it

The test looks for an agentOS checkout in two places, in order:

1. `$AGENTOS_SRC`, if set
2. the sibling directory `../agentos` next to this repo

```sh
cd src-tauri
cargo test drift_guard_against_agentos_source -- --nocapture   # uses ../agentos or $AGENTOS_SRC
AGENTOS_SRC=/path/to/agentos cargo test drift_guard_against_agentos_source -- --nocapture
```

It also runs as part of the normal `cargo test` / `cargo test --lib` suite in `src-tauri/`.

### Two modes: optional locally, required in CI

**Locally, absent a sibling checkout, the guard skips — it does not fail, and critically, it
does not silently pass as if it had verified something.** A `cargo test` run with no tree
available still prints `test cc_ipc::tests::drift_guard_against_agentos_source ... ok` — that
line only means "did not panic," which is Rust's test harness, not a claim that this test
checked anything. To tell the two apart, run with `-- --nocapture` (by default, `cargo test`
captures and discards output from passing tests) and look for one of two banners:

```
*** DRIFT GUARD: comparing against agentOS source at <path> ***            # it ran
*** DRIFT GUARD SKIPPED: agentOS source tree not found. ***                # it skipped
```

A failed run always shows its output regardless of `--nocapture`, so a drift that actually
breaks the test is loud either way.

That ambiguity — "ok" meaning either "verified 27 opcodes plus the handshake and authority
layout" or "found nothing and checked nothing" — is harmless on a contributor's laptop (they
can just run with `--nocapture` to check), but it is exactly the gap that let this repo go
four months without anyone noticing it couldn't connect: **no CI ran anything at all.**
Set `AGENTOS_DRIFT_GUARD_REQUIRED=1` to remove the ambiguity by converting a skip into a hard
test failure:

```sh
AGENTOS_SRC=/path/to/agentos AGENTOS_DRIFT_GUARD_REQUIRED=1 cargo test   # tree missing => FAILS, not skips
```

Leave `AGENTOS_DRIFT_GUARD_REQUIRED` unset for normal local development — a contributor
without the agentOS tree cloned should not be blocked by this test.

### CI

`.github/workflows/ci.yml` checks out this repo and `jordanhubbard/agentos` as siblings
(`actions/checkout` with `path: agentos_gui` / `path: agentos`), then runs `npm ci`,
`npm run check`, the Playwright suite, and `cargo test` under `src-tauri/` with
`AGENTOS_SRC=$GITHUB_WORKSPACE/agentos` and `AGENTOS_DRIFT_GUARD_REQUIRED=1`. Because the
checkout step guarantees the tree is present, a skip in that job means the checkout itself
broke, not that the tree is legitimately absent — so the required flag turns that into a
build failure instead of a silently green run.

It deliberately does **not** attempt to build or boot agentOS: that needs the qualified seL4
SDK and a QEMU/hardware target, well outside what a GUI's CI should require. It reads only
agentOS's *source headers* off disk for the drift guard — no agentOS build step runs.

**What this CI does not cover:** anything that requires a live `cc_pd` to observe, such as a
refused call inside a `Promise.all` silently breaking an unrelated UI panel (the GUI's
"bricked dashboard" bug from this same hardening effort). That is a runtime interaction
between two running processes, not a constant mismatch the drift guard can see by reading
headers. Catching it would need a separate job that boots agentOS and drives the GUI against
a real socket — tracked as a follow-up, not attempted here.

## Tabs

| Tab     | API calls                                   |
|---------|---------------------------------------------|
| Guests  | `MSG_CC_LIST_GUESTS`, `MSG_CC_GUEST_STATUS`, `MSG_CC_CREATE_GUEST`, `MSG_CC_SEND_INPUT`, `MSG_CC_SNAPSHOT`, `MSG_CC_RESTORE`, traffic inspector |
| Devices | `MSG_CC_LIST_DEVICES`, `MSG_CC_DEVICE_STATUS` |
| Logs    | `MSG_CC_LOG_STREAM` with slot / PD selectors |
| Agents  | `MSG_CC_LIST_POLECATS`                      |
| API     | `MSG_CC_SEND`, `MSG_CC_RECV`, `MSG_CC_STATUS`, `MSG_CC_LIST`, `MSG_CC_ATTACH_FRAMEBUFFER`, `MSG_CC_FAULT_INJECT` |

Connection flow uses `MSG_CC_CONNECT` and `MSG_CC_DISCONNECT`. Guest launch and
console input use `MSG_CC_CREATE_GUEST` and `MSG_CC_SEND_INPUT`.
