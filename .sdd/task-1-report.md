# Task 1 report — Reconnect to current cc_pd

## What changed

All changes are in `src-tauri/src/cc_ipc.rs` (`commands.rs` needed no change — `cc_connect` already
propagates `CcClient::connect`'s `io::Error` via `.to_string()`, so the new actionable messages
reach the frontend unmodified).

1. **Bootstrap constants** (re-declared, not built against the agentOS tree):
   - `MSG_CC_CONNECTION_SYNC = 0x261F`
   - `CC_CONNECTION_MAGIC = 0x4343_5244`, `CC_CONNECTION_VERSION = 1`, `CC_OK = 0`
   - `CC_OPERATOR_TOKEN_BYTES = 32`
   - `CC_GREETING_SIZE = 4112` (same wire shape as a reply: `mr[4]` + 4096-byte shmem)
   - `CC_DEV_OPERATOR_TOKEN_HEX`, the well-known development token, hex-encoded. I read the real
     value out of `kernel/agentos-root-task/include/cc_operator_credential.h` in the sibling
     `../agentos` checkout available on this machine (not a build dependency — I only read the
     header text, the same way the brief told me to trust its quoted handshake over inference).
     Decoded it is `"agentOS-dev-operator-token-v1"` + 3 zero bytes. `CC_CONNECTION_VERSION` and
     `CC_CONNECTION_MAGIC` were confirmed the same way against
     `kernel/agentos-root-task/include/contracts/cc_contract.h`, and the handshake sequence against
     `services/command-console/cc_pd.c` (the `connection_active` branch) — all comments in the new
     code cite those files as the source of truth, per the brief's instruction not to add a build
     dependency.
   - All new/changed code and comments describe the credential as selecting an authority envelope,
     never as authentication or a secret.

2. **`ConnectionGreeting` struct** — `{ magic, version, generation_lo, generation_hi }`, with a
   doc comment stressing the generation is per-connection and must never be cached/hardcoded.

3. **`CcClient::connect`** now performs, in order:
   - Resolve the operator credential (fails loudly before touching the socket if
     `AGENTOS_CC_OPERATOR_TOKEN_HEX` is set but malformed).
   - `read_greeting()` — blocking read of the unprompted 4112-byte greeting, validates the magic,
     parses version/generation.
   - `send_sync()` — builds and sends the `MSG_CC_CONNECTION_SYNC` frame via `build_sync_frame()`
     (opcode `0x261F`, `mr[0]`=echoed version, `mr[1..2]`=echoed generation lo/hi, shmem[0..32]=
     credential, shmem[32..] zero-by-construction), then reads the reply and checks `CC_OK` plus
     that version/generation were echoed back.
   - Only then proceeds to `MSG_CC_CONNECT` to establish the session this client's other commands
     (`SEND`/`RECV`/`STATUS`/...) rely on — unchanged from before except it now runs after sync
     instead of being the very first frame on the wire.

4. **`bootstrap_io_error()`** — maps EOF/ConnectionReset/BrokenPipe and TimedOut/WouldBlock seen
   while reading the greeting or the sync reply to a distinct, actionable message:
   *"cc_pd closed the connection ... credential rejected or protocol version mismatch. Check
   AGENTOS_CC_OPERATOR_TOKEN_HEX and that this client's CC_CONNECTION_VERSION matches the running
   cc_pd."* This matches the brief's requirement: `cc_pd` closes without replying on any mismatch,
   so the client only ever sees EOF/timeout, never an error opcode — other I/O error kinds pass
   through unchanged (not papered over as "credential rejected").

5. **Credential loading** — `operator_credential()` reads `AGENTOS_CC_OPERATOR_TOKEN_HEX`; if unset,
   returns the development token; if set but not exactly 64 hex chars (or contains non-hex
   characters), returns a loud `InvalidInput` error naming the problem rather than silently falling
   back. `parse_credential_hex()` / `dev_operator_credential()` are the two small helpers behind it.

6. **Unit tests** (`#[cfg(test)] mod tests` at the bottom of `cc_ipc.rs`), covering Step 1 of the
   brief plus the "don't hardcode the generation" review-focus item:
   - `sync_frame_echoes_greeting_and_carries_credential` — asserts opcode `0x261F`, echoed version
     and both generation words, credential in `shmem[0..32]`, and all of `shmem[32..]` zero.
   - `sync_frame_tracks_generation_changes_across_reconnects` — builds frames from two synthetic
     greetings differing only in generation and asserts the frames differ there, guarding against a
     hardcoded/cached generation.
   - `dev_credential_is_well_formed`, `credential_hex_round_trips`,
     `malformed_credential_hex_is_rejected_not_silently_defaulted` — credential parsing edge cases.

## Verification

### `cargo test` (under `src-tauri/`)

```
$ cd src-tauri && cargo test
   Compiling agentos-gui v0.1.0 (/Users/jkh/Src/agentos_gui/src-tauri)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 1m 22s
     Running unittests src/lib.rs (target/debug/deps/agentos_gui_lib-fa9e5d287b8bf30a)

running 5 tests
test cc_ipc::tests::dev_credential_is_well_formed ... ok
test cc_ipc::tests::malformed_credential_hex_is_rejected_not_silently_defaulted ... ok
test cc_ipc::tests::credential_hex_round_trips ... ok
test cc_ipc::tests::sync_frame_echoes_greeting_and_carries_credential ... ok
test cc_ipc::tests::sync_frame_tracks_generation_changes_across_reconnects ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```
(main.rs unit tests and doc-tests also ran: 0 tests each, both `ok`.)

I did not do a literal red→green commit-by-commit demonstration for this test (that rigor is
explicitly demanded for Task 4's drift guard, not Task 1); I wrote the test against the
not-yet-existing `build_sync_frame`/`ConnectionGreeting` API, confirmed it fails to compile without
the implementation, then implemented and confirmed green. `cargo build` also reports zero warnings.

### `npm run check`

```
$ npm run check
> agentos-gui@0.1.0 check
> tsc --noEmit
```
Clean, no output, exit 0. No `.ts`/`.tsx` files were touched by this task.

### Playwright suite (`npm test`)

```
$ npm test
...
93 passed (33.4s)
```
All 93 existing tests pass unchanged. These tests mock `window.__TAURI__.invoke` at the browser
level, so they do not exercise `cc_ipc.rs`'s socket code at all — they only prove the frontend
still works, not that the new handshake works against a real `cc_pd`.

## What I could and could not test

- **Could test:** frame construction logic (`build_sync_frame`, `read_greeting`'s parsing,
  `operator_credential`/`parse_credential_hex`) via the Rust unit tests above, against synthetic
  data. This is the "achievable proof" the task brief anticipated.
- **Could not test:** an actual handshake against a running `cc_pd`. I do not have agentOS built and
  booted in this environment — no live Unix socket exists to connect `CcClient::connect` to, and I
  was explicitly told not to spin that up. **I did not run `cc_connect` against any socket, mock or
  real, and I am not claiming the connection works end-to-end** — only that the frame this client
  builds matches the handshake exactly as described in the brief, and as independently confirmed by
  reading `services/command-console/cc_pd.c` and `cc_contract.h` in the sibling `../agentos`
  checkout present on this machine.

## Things that worried me

- The well-known development token and `CC_CONNECTION_VERSION=1` are copied from the sibling
  `../agentos` checkout's current `main`-ish state on this machine, not from any artifact shipped
  with this repo or task. If that checkout is stale or diverges from what the GUI will actually
  run against, these literals will be wrong and the client will fail the sync with exactly the
  "credential rejected or protocol version mismatch" message it's designed to produce — which is
  at least the correct failure mode, not a silent hang, but it's worth flagging that the values
  came from reading a nearby tree rather than from this task's own inputs. Task 4 (the drift guard)
  is explicitly designed to catch exactly this kind of staleness going forward, which reassures me
  this is an accepted, caught risk rather than a loose end.
- I kept `CcClient::connect` always issuing `MSG_CC_CONNECT` after sync (as it did before), since
  every other method on `CcClient` is session-based and relies on `session_id`. The brief notes
  `INSPECT`/`OPERATOR_*`/`AUTHORITY` are sessionless and "only then may `MSG_CC_CONNECT` establish a
  session — and only for session-based use," but building a sessionless connection path is outside
  this client's current command surface (no sessionless commands exist yet — `AUTHORITY` is Task 3).
  I did not invent a parallel sessionless `connect()` variant since nothing calls it yet; flagging
  this as a decision rather than an oversight.
