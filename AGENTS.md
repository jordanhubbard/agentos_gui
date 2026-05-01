# agentOS GUI — Agent Development Guidelines

**This file is mandatory reading for any AI agent or developer working in this repository.**

## What This Project Is

`agentos_gui` is the external desktop UI for `agentOS`.

It is not part of the operating system. It does not run as a seL4 Protection
Domain. It is a host-side Tauri desktop app that connects to a running agentOS
instance through the Command-and-Control Protection Domain (`cc_pd`) socket.

The intended local topology is:

```text
../agentos running in QEMU
  cc_pd
    <-> VirtIO serial
    <-> ../agentos/build/cc_pd.sock
    <-> agentos_gui
```

## Repository Boundary

This repository may contain UI code. The sibling `../agentos` repository may not.

Do not copy UI code, web assets, Node tooling, Tauri code, or browser-facing
logic into `../agentos`. If a change needs operating-system support, add or
modify the IPC contract and implementation in `../agentos`, then update this GUI
as an external consumer.

## Technology Stack

- Frontend: React + TypeScript + Vite
- Desktop shell: Tauri 2
- Backend bridge: Rust Tauri commands in `src-tauri/src/`
- Transport: Unix domain socket speaking the `cc_pd` binary wire protocol
- Package manager: npm, using the checked-in `package-lock.json`

Do not add a web server or HTTP bridge for normal operation. The GUI talks
directly to the `cc_pd` Unix socket.

## Default Workflow

Start agentOS first from the sibling repository:

```sh
cd ../agentos
make run
```

The default agentOS run boots the local Ubuntu guest and opens the CC-PD socket
at `build/cc_pd.sock`.

The GUI top-level workflow must mirror `../agentos`:

```sh
make build
make run
```

`make build` builds the native desktop app.

`make run` runs the native app and sets `CC_PD_SOCK` to:

```text
../agentos/build/cc_pd.sock
```

It also sets `AGENTOS_GUI_AUTOCONNECT=1`, so the app attempts to connect to the
running agentOS instance immediately on launch.

Users may override either path:

```sh
make run AGENTOS_DIR=/path/to/agentos
make run CC_PD_SOCK=/path/to/cc_pd.sock
```

For hot-reload development, use:

```sh
make dev
```

## CC-PD Contract Rules

The GUI is a consumer of the published `cc_pd` contract:

- Source of truth in agentOS:
  - `../agentos/kernel/agentos-root-task/include/contracts/cc_contract.h`
  - `../agentos/kernel/agentos-root-task/include/agentos.h`
- GUI mirror:
  - `src-tauri/src/cc_ipc.rs`

When opcodes or wire structs change in `../agentos`, update the Rust mirror in
this repo in the same change set.

Do not include kernel headers directly from `../agentos` in the GUI build. Keep
the GUI self-contained and re-declare only the stable protocol constants and
wire structs it needs.

## Wire Protocol

The CC-PD socket protocol is fixed-size binary framing:

```text
Request: opcode(4) + mr[3](12) + shmem(4096) = 4112 bytes
Reply:   mr[4](16) + shmem(4096)             = 4112 bytes
```

All multi-byte integers are little-endian. Keep parsing strict and deterministic.
Do not switch this protocol to JSON, HTTP, WebSocket, or another transport unless
the `cc_pd` contract changes first.

## UX Rules

The GUI should make the local agentOS path obvious:

- Prefer `CC_PD_SOCK` when it is set.
- Otherwise prefer the sibling socket at `../agentos/build/cc_pd.sock`.
- Autoconnect only when `AGENTOS_GUI_AUTOCONNECT` is explicitly enabled.
- Surface socket connection failures clearly.
- Do not hide protocol errors behind generic “offline” states.

This application is an operational UI, not a marketing site. Keep layouts dense,
clear, and task-oriented. Avoid decorative screens that delay access to guests,
devices, logs, or agent status.

## Testing And Quality Gates

Before handing off frontend/backend changes, run the narrowest relevant checks:

```sh
make check
make test
```

For Rust/Tauri-only changes, also run:

```sh
cargo check --manifest-path src-tauri/Cargo.toml
```

For full release validation, run:

```sh
make build
```

If a check cannot be run because dependencies or system GUI libraries are
missing, say so explicitly in the handoff.

## Editing Rules

- Keep generated artifacts out of commits:
  - `node_modules/`
  - `dist/`
  - `src-tauri/target/`
  - `src-tauri/gen/`
  - Playwright reports and test results
- Keep protocol constants synchronized with agentOS.
- Prefer existing components and hooks before adding new abstractions.
- Keep Tauri commands small and typed.
- Keep socket I/O in `src-tauri/src/cc_ipc.rs`.
- Keep UI state in React hooks/components, not in global browser variables.

## Common Tasks

Build and run against the sibling agentOS checkout:

```sh
cd ../agentos
make run

cd ../agentos_gui
make build
make run
```

Run the GUI in development mode:

```sh
make dev
```

Use a non-default socket:

```sh
make run CC_PD_SOCK=/tmp/custom-cc.sock
```
