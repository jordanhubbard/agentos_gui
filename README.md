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

## Guest display and keyboard

Use an agentOS profile with GPU and input devices, such as
`make run GUEST_OS=debian-graphics-input`. After the guest exposes its
framebuffer, capture a frame or start live display. Click the displayed frame
to send physical keyboard events to that guest; its keyboard layout controls
the resulting text. `Ctrl+Alt+Escape` releases focus. Changing focus or guests
queues releases for held keys. The console below remains a separate serial
input path.

Input batches are bounded and acknowledged in order. A rejected or uncertain
delivery stops further input. **Release guest keys** sends releases for keys
that may have reached the guest, without replaying presses. If the connection
has failed, releases cannot be guaranteed; guest-side recovery may be needed.
Host-reserved shortcuts may never reach the app. IME composition and graphical
pointer input are not implemented.

Live display currently transfers full snapshots and can take tens of seconds
per frame on Spark. This is not yet a responsive remote desktop.

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

<!-- ai-template:narrative:start -->
## The Totally True and Not At All Embellished History of agentos_gui

### The continuing adventures of Jordan Hubbard and Sir Reginald von Fluffington III

> *Part 16 of an ongoing chronicle. [← Part 15: Crust](https://github.com/jordanhubbard/crust#the-totally-true-and-not-at-all-embellished-history-of-crust) | [Part 17: PythonOS →](https://github.com/jordanhubbard/pythonos#the-totally-true-and-not-at-all-embellished-history-of-pythonos)*
> *[Chronicle index](https://github.com/jordanhubbard/ai-template/blob/main/CHRONICLE.md) · Ordered by first recorded AI-assisted commit.*

The programmer had built an operating-system platform for agents and had been quite firm that human user interfaces did not belong inside it.

Then he wanted to see what it was doing.

Sir Reginald von Fluffington III watched this development from outside the keyboard, a temporary separation of concerns caused by the keyboard being unavailable beneath several pages of protocol notes.

“A separate application,” the programmer explained. “It will speak the public contract.”

This was agentos_gui: a Tauri desktop application with a Rust bridge and a React interface. It would connect to the CC-PD Unix socket of a running agentOS instance and turn requests and replies into views a human could inspect. The kernel would not acquire a dependency on a button merely because the programmer wanted one.

The interface exposed guests, devices, logs, agents, and the API. Protocol constants were declared from the published contract rather than imported through kernel headers. This preserved the boundary and created the entirely reasonable obligation to keep the opcode values synchronized. Sir Reginald considered all numeric protocols inferior to his own, in which one fixed stare meant several dozen things depending on context.

Requests and replies were each 4,112 bytes. The programmer appreciated the symmetry. The cat appreciated the piece of paper on which it had been calculated and sat down on it.

A bounded traffic ring made exchanges visible in a live inspector. When a guest did not do what was expected, the programmer could look at the messages rather than debate a diagram. The application also needed something to connect to: agentOS first, GUI second. A desktop window was not evidence that an operating system had booted.

“Now I can see the boundary,” the programmer said.

Sir Reginald stepped across it and occupied the keyboard. The demonstration was clear, the ownership model was disputed, and endorsement remained pending a Guests tab capable of listing the bird outside the window.

<!-- ai-template:narrative:end -->
