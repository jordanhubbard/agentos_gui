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

