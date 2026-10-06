# T7 — GUI: reconnect, harden, and show real authority

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make `agentos_gui` connect to current `cc_pd` again, close the hardening gaps that let frontend code reach the control socket, and replace the hardcoded topology diagram with the real authority relation agentOS now publishes.

**Architecture:** Three independent problems in one client. (1) The wire contract moved twice and the GUI never followed. (2) The Tauri shell is configured permissively enough that any script reaching the webview can drive the OS control socket. (3) The topology view renders a hand-drawn diagram annotated with the GUI's own message traffic, so it shows the GUI's API surface rather than the system's.

**Repo note:** this is the external GUI consumer. agentOS's C/Rust/Assembly language policy does **not** apply here — TypeScript/React/Rust/Tauri are correct. agentOS's `CLAUDE.md` names `../agentos_gui` as the sanctioned out-of-tree consumer.

## The situation, established by evidence

**The GUI has been unable to connect since 2026-09-21**, not since the recent trust work. `MSG_CC_CONNECTION_SYNC` entered `cc_pd` in commit `fd7d1dcd` (2026-09-21); the GUI's last commit is `d40bf01` (2026-05-03) and contains no `CONNECTION_SYNC` anywhere. `cc_pd` closes any connection whose first frame is not `CONNECTION_SYNC`, so `CcClient::connect` — which opens the socket and immediately sends `MSG_CC_CONNECT` — has had its connection dropped for four months.

The recent T1 work added a credential to that same handshake. It did not cause the break; it landed on an existing one.

**Nothing in agentOS's `make gate` or CI exercises the GUI against a live `cc_pd`.** That is why a four-month break went unnoticed, and it will recur unless this plan leaves something behind that catches it.

## Global Constraints

- The GUI re-declares protocol constants rather than including agentOS headers. That separation is deliberate (`README.md`) and must be preserved — do **not** add a build dependency on the agentOS tree.
- The operator credential is **not a secret**. agentOS's threat model treats the local operator as untrusted and assumes they can read the image; the credential selects an authority envelope, it does not authenticate anyone. Never describe it as authentication or as a secret in code, comments or UI text.
- The GUI cannot exceed the control plane's guarantees. Possession of the socket plus the credential confers the operator envelope — nothing this plan does makes the GUI a security boundary, and no UI copy may imply otherwise.
- Keep the existing Playwright suite green; it is the only regression net this repo has.

## Review Focus

1. **A handshake that appears to work but does not.** The sync frame must echo the generation `cc_pd` sent in its greeting. Hardcoding a generation, or skipping the greeting read, yields a client that works once against a fresh PD and fails mysteriously after a reconnect. → Task 1.
2. **CSP added but ineffective.** A policy that still permits `unsafe-inline` or a wildcard source closes nothing. → Task 2.
3. **Capability scoping that breaks the app silently.** Narrowing Tauri permissions can disable commands at runtime with no compile error. Every command the UI invokes must still work. → Task 2.
4. **An authority view that invents data.** If `MSG_CC_AUTHORITY` is unavailable or fails, the view must say so, not fall back to a plausible-looking hardcoded graph. That failure mode is how the current diagram came to be mistaken for real. → Task 3.
5. **A drift guard that never runs.** → Task 4.

---

### Task 1: Reconnect to current `cc_pd`

**Files:** `src-tauri/src/cc_ipc.rs`, `src-tauri/src/commands.rs`

**The handshake, exactly:**
1. `cc_pd` **sends first**: a 4112-byte greeting frame — `mr[0]` = magic `0x43435244`, `mr[1]` = `CC_CONNECTION_VERSION`, `mr[2]` = generation low 32, `mr[3]` = generation high 32.
2. The client replies with a request frame: opcode `MSG_CC_CONNECTION_SYNC` (`0x261F`), `mr[0]` = the version it was sent, `mr[1]`/`mr[2]` = the generation low/high it was sent, the **first 32 bytes of shmem** = the operator credential, **every remaining shmem byte zero**.
3. `cc_pd` replies `CC_OK` with version and generation echoed, and the connection becomes active.
4. Only then may `MSG_CC_CONNECT` establish a session — and only for session-based use. `INSPECT`, `OPERATOR_*` and the authority read are sessionless.

A mismatch in version, generation, credential, or any nonzero reserved byte causes `cc_pd` to close the connection without a reply. Surface that to the user as a distinct, actionable error — "credential rejected or protocol version mismatch" — not a generic I/O failure.

- [ ] **Step 1:** Write a failing Rust unit test in `cc_ipc.rs` that builds a sync frame from a synthetic greeting and asserts: opcode `0x261F`, version and both generation words echoed from the greeting, credential in `shmem[0..32]`, and `shmem[32..]` all zero. Run it; it must fail.
- [ ] **Step 2:** Implement `read_greeting()` and `send_sync()`; have `CcClient::connect` perform greeting → sync → (optional) `MSG_CC_CONNECT`. Do not hardcode the generation.
- [ ] **Step 3:** Credential source: read `AGENTOS_CC_OPERATOR_TOKEN_HEX` (64 hex chars) if set, else the well-known development token. **Fail loudly** on a malformed value — a typo must not silently fall back and produce a confusing closed connection. Comment that `kernel/agentos-root-task/include/cc_operator_credential.h` in the agentOS tree is the source of truth, without depending on it.
- [ ] **Step 4:** Run the test; it must pass. Run `npm run check` and the Playwright suite.
- [ ] **Step 5:** Commit.

---

### Task 2: Close the hardening gaps

**Files:** `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `package.json`, `src-tauri/src/commands.rs`

- [ ] **Step 1: Content Security Policy.** `tauri.conf.json` has `"csp": null`. Set a restrictive policy — at minimum `default-src 'self'`, no `unsafe-inline`, no wildcard origins. Then run the app and the Playwright suite: a CSP that breaks the UI is not shippable, and one that permits `unsafe-inline` closes nothing. Report the exact policy you settled on and what you had to allow.
- [ ] **Step 2: Scope the Tauri capability set.** `capabilities/default.json` grants `core:default` over a 29-command surface. Enumerate the commands the UI actually invokes (grep `invoke(` in `src/`) and grant only those. Verify every UI path still works — narrowing permissions fails at runtime, not compile time.
- [ ] **Step 3: Remove `@tauri-apps/plugin-shell`.** It is declared in `package.json`, registered nowhere in `lib.rs`, and granted nothing. Inert today, one line from being an arbitrary-execution surface in a window that speaks to the OS control socket. Remove the dependency and confirm nothing imports it.
- [ ] **Step 4: Validate the socket path in Rust.** `cc_connect` accepts an arbitrary path string from the frontend and opens it. Restrict it: accept only a path the backend resolved itself (the `CC_PD_SOCK` env var, the sibling-repo default, or an explicit user selection), and reject anything else with a clear error. The frontend must not be able to point the backend at an arbitrary Unix socket.
- [ ] **Step 5:** Run `npm run check` and the Playwright suite. Commit.

---

### Task 3: Show the real authority relation

**Files:** `src-tauri/src/cc_ipc.rs`, `src-tauri/src/commands.rs`, `src/components/TopologyGraph.tsx`, `src/types.ts`

agentOS now publishes a per-domain count of each capability kind the root task granted, readable over CC as `MSG_CC_AUTHORITY` (`0x2620`), which is admitted to the operator envelope. The reply carries an `aos_authority_snapshot_t`: a header (`version`, `pd_count`, `total_recorded`, `truncated_adds`, `saturated`, reserved — 24 bytes) followed by 32 rows of `{ uint32 pd_index; char name[48]; uint16 counts[11]; uint16 reserved; }` (80 bytes each). Kind order is ABI: untyped, tcb, endpoint, notification, cnode, frame, vspace, irq_handler, sched_context, reply, other.

- [ ] **Step 1:** Add `cc_authority()` to `cc_ipc.rs` and a `cc_authority` Tauri command, parsing the snapshot into typed rows. Validate `version` and bound `pd_count` before indexing.
- [ ] **Step 2:** Replace `TopologyGraph.tsx`'s hardcoded node layout with a view rendered from that data: one node per protection domain, labelled with its name and the capability kinds it holds.
- [ ] **Step 3: On failure, say so.** If the call fails or the opcode is unsupported by the connected `cc_pd`, render an explicit "authority data unavailable" state. **Do not fall back to a drawn diagram.** A plausible-looking fallback is exactly how the current hardcoded graph came to be read as real.
- [ ] **Step 4: Honesty in the UI.** This is a record of what the root task granted at boot, not live kernel state — seL4 exposes no capability-enumeration syscall. Label the view accordingly, and do not call it an audit, a verification, or live state.
- [ ] **Step 5:** Update the Playwright suite to cover both the populated and unavailable states. Run `npm run check` and the suite. Commit.

---

### Task 4: Leave something behind that catches the next drift

**Files:** `src-tauri/src/cc_ipc.rs` (tests), `README.md`

A four-month break went unnoticed because nothing checks this client against the server it talks to.

- [ ] **Step 1:** Add a Rust test that locates the agentOS tree if present (sibling `../agentos`, or `AGENTOS_SRC`), parses the `MSG_CC_*` opcode definitions out of `kernel/agentos-root-task/include/agentos.h`, and asserts the GUI's re-declared constants match. When the tree is absent, the test must **skip with a clear message**, not pass silently — a guard that quietly no-ops is worse than none.
- [ ] **Step 2:** Extend it to the handshake constants it can reach the same way: `CC_CONNECTION_VERSION`, the wire frame sizes, and `CC_OPERATOR_TOKEN_BYTES`.
- [ ] **Step 3:** Document in `README.md` how to run it and what it protects, stating plainly that the constants are re-declared by design and this test is what keeps the duplication honest.
- [ ] **Step 4:** Demonstrate it works: temporarily change one re-declared opcode, show the test fails, restore, show it passes. Paste all three outputs.
- [ ] **Step 5:** Commit.

---

## Notes for the implementer

**The honesty constraints here are about the UI, where they matter most.** A dashboard is the artifact people believe. The topology view must not invent data, the authority view must not be called live kernel state, and nothing may describe the credential as authentication — agentOS's own threat model says the operator is untrusted and can read it.

**If the handshake will not complete, do not work around it.** A client that skips the sync, or retries until something sticks, would be worse than one that fails cleanly. Report what `cc_pd` did.

**You cannot run a live `cc_pd` from this repo.** Testing against a real socket needs agentOS built and booted in a sibling checkout. Where you cannot test live, say so plainly rather than claiming a connection worked.
