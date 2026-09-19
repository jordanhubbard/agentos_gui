# Remote desktop contract integration

The native GUI uses the existing CC-PD Unix socket and fixed binary frames.
The source contracts are agentOS `cc_contract.h`, `framebuffer_observer.h`,
and `input.h`. The GUI remains a separate host application.

## Input bridge

`cc_input_submit(handle, device, events)` mirrors opcode `0x261e`, input
version 1. Device 0 is the keyboard; device 1 is the relative pointer. Each
batch has 1–64 Linux input events and ends with exactly one SYN_REPORT.
The Rust bridge validates the complete batch before sending it and writes
the fixed 544-byte request with reserved fields zeroed.

The response is `{status, accepted}`. Status 0 must acknowledge the complete
batch. Status 1 (bad request), 2 (denied), or 3 (would block) must acknowledge
zero events. Only status 3 permits retrying the same batch. A transport error
or malformed acknowledgment leaves the remote input outcome unknown: do not
replay the batch. A partial socket transfer closes the stream; reconnect
before further use. The existing console-byte API remains separate.

Consumers must await each acknowledgment before submitting the next batch.
The bridge performs no automatic retries. The existing bounded traffic ring
records batch size, response status, and round-trip duration.

## Frame capture

The Guests view can capture one immutable display frame. `cc_frame_capture`
returns dimensions, byte count, a decimal sequence string, and a process-local
token. `cc_frame_read` returns binary XRGB8888 bytes, at most 4056 per call;
`cc_frame_release` frees the snapshot. The bridge validates dimensions, bounds,
cookie, sequence and metadata on every reply. Tokens are not server cookies
and cannot be reused after reconnect even if a rebooted server repeats a cookie.

The view runs one capture at a time and awaits each chunk, releasing the socket
lock between reads. It presents only complete frames, converts BGRX bytes to
opaque canvas RGBA, and reports transferred bytes and elapsed time. Cancellation,
guest switching and component teardown stop further reads and release the token
after the outstanding call completes. Transport and release errors stay visible.

The [Spark native capture receipt](evidence/2026-09-17-spark-frame.json) records
two real captures over CC-PD, including a blue guest virtual terminal with
visible proof text. The 3 MiB pattern capture took 86.8 seconds with normal
status polling active. This qualifies still-frame display, not desktop latency.

### Transport latency probe

Close the GUI and run `make benchmark-frame CC_PD_SOCK=/path/to/cc_pd.sock
BENCH_GUEST_HANDLE=0xHANDLE BENCH_READS=128` (one shell command). Use the
selected guest's public handle. The Rust example uses the production CC client,
measures 16 status requests, captures a frame, repeatedly reads its first
4056 bytes, checks that those immutable bytes stay identical, and releases it.
It prints JSON containing wall time, recorded socket time, and latency
distributions. It does not transfer the whole frame or measure input latency.

For a smaller native producer, start agentOS with
`make run GUEST_OS=none FRAMEBUFFER_TEST=1` and use handle `0xfb000000`.
This test-only handle selects a 40 by 40 pixel surface; it is not a guest.
The [Spark transport baseline](evidence/2026-09-17-spark-transport.json)
records 128 reads taking 8.69 and 9.28 seconds without GUI polling. A third
sample taken while host tests ran took 14.78 seconds. In every sample, over
99% of read wall time was accounted for by socket calls. Host contention
affects timing; these measurements establish a baseline, not a frame-rate
guarantee or a confirmed scheduling diagnosis.

## Remaining integration

Continuous refresh, keyboard focus, relative pointer capture, and a shared
bounded input queue are now implemented. GUI PRs #5, #6, and #7 are merged.
The [native refresh receipt](evidence/2026-09-17-live-display.json),
[keyboard receipt](evidence/2026-09-17-guest-keyboard.json), and
[pointer receipt](evidence/2026-09-17-guest-pointer.json) record successive guest
frames and input arriving at guest evdev devices on Spark. Earlier receipts
describe the limitations at their recorded revisions; later receipts qualify
the added functionality.

This does not yet qualify a responsive remote desktop. Recorded 1024 by 768
captures take 27.8–34.6 seconds. Reads remain limited to 4056 pixel bytes per
round trip. Remaining work includes reducing transfer latency, measuring input
latency during refresh, qualifying interaction with a graphical guest application,
and guaranteeing held-input cleanup after abrupt disconnection. Server-side
presentation acknowledgment and incremental frame transfer are not implemented.
The native pointer test qualifies release on Escape, not cleanup after a lost
connection. These gaps remain part of the combined OS and GUI release review.

Useful principles from the shared PythonOS/RubyOS RemoteOS-SDL service are
bounded binary transfers, ordered input acknowledgment, and per-operation
telemetry. Its JSON envelope and drawing-command protocol are not the agentOS
CC ABI. Frame and input operations here remain separate contracts.

RemoteOS-SDL protocol v2 also scopes handles to a connection, negotiates limits
and features, and distinguishes ordered one-way operations from acknowledged
operations. Its `frame.commit` combines presentation and event polling. These
are useful design references for future agentOS contract changes, not capabilities
that the current CC protocol already provides. In particular, an input batch
acknowledgment must not be presented as proof that a guest application consumed
the event or that its resulting frame appeared on screen. Track capture,
transfer, presentation, and input timings separately when qualifying latency.

Validation uses Unix socket pairs and exact request/reply bytes, plus browser
tests checking actual canvas pixels, cancellation and transfer errors. These
host tests do not prove display or input delivery against a running guest;
that requires a GUI-to-agentOS target test.
Run `make test-rust`, `make check`, and `make test`; `make build` validates
the native release executable. Linux builds need GTK 3 and WebKitGTK 4.1
development packages. macOS keeps its app bundle, while Linux builds the
executable used by `make run` without an installer by default.

On Linux systems with an NVIDIA DRM render device, startup defaults
`WEBKIT_DISABLE_DMABUF_RENDERER` to `1` before initializing WebKit. This avoids
the blank window caused by failed GBM buffer allocation on Spark. An explicit
environment value takes precedence; for example,
`WEBKIT_DISABLE_DMABUF_RENDERER=0 make run` tests the default WebKit DMA-BUF path.
Other GPU vendors and non-Linux platforms retain their normal renderer choice.

### Optional packed snapshot reads

The native bridge mirrors agentOS `READ_PACKED` (observer operation 4,
version 1). It requests a pixel-aligned prefix of the same immutable snapshot
and validates the unchanged cookie, sequence and dimensions. The payload has
an eight-byte little-endian decoded-length/encoding header, followed by raw
XRGB bytes or nonzero pixel-count/XRGB runs. Decoding rejects truncated runs,
trailing bytes, unknown encodings and expansion beyond the request or 64 KiB.
The OS selects raw encoding when runs do not improve the returned prefix.

GUI batches keep their existing 32448-byte and 25 ms bounds. They can now
advance by more than 4056 decoded bytes per wire round trip; incomplete batches
still return to release the client lock for input and cancellation. A legacy
CC `INVALID_ARG` response to operation 4 disables packed reads for the current
snapshot and uses the existing raw operation. Transport failures, malformed
payloads and changed snapshot metadata never trigger silent fallback.

`make benchmark-frame-transfer CC_PD_SOCK=... BENCH_GUEST_HANDLE=0`
compares complete raw and GUI-batched transfers of one captured snapshot,
requiring every decoded byte to match. `BENCH_ORDER=packed-first` reverses the
order. This measures the production Rust client without native rendering or
guest input; live interactive acceptance remains a separate requirement.

The [Spark packed-frame receipt](https://github.com/jordanhubbard/agentos/blob/40d54c0/docs/evidence/2026-09-19-spark/packed-frame.json)
records two complete 3 MiB comparisons with exact pixel equality: packed
GUI batches took 1.24/1.41 seconds versus raw reads at 9.54/8.64 seconds.
The native window displayed captures in 1.6–2.0 seconds, visibly delivered
`packed-ui` keyboard input during live refresh, cleared it with Ctrl+U, and
stopped and closed normally. This qualifies that mostly flat Debian console
case. Varied desktop content, precise input-to-screen latency, pointer behavior
and abrupt-disconnect cleanup remain outside this result. The receipt also
preserves earlier cold-boot failures; their cause is not established by the
successful run.
