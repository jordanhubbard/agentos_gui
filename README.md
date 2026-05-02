# agentos_gui

Desktop UI for [agentOS](https://github.com/jkh/agentos). Connects to a running agentOS
instance via the CC-PD socket and exposes the full `cc_contract.h` API surface through
a native desktop application.

**Zero kernel headers included.** All protocol constants are re-declared from the published
CC contract spec. The only dependency on the agentOS repo is keeping opcode values in sync
with `agentos.h` when they change.

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
