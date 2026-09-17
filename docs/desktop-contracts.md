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

## Remaining integration

This is a still-frame viewer, not yet an interactive remote desktop. The next
layer must manage keyboard/pointer focus, ordered bounded input delivery, and
continuous refresh without queueing work behind a slow frame transfer.
The observer contract currently requires reads of at most 4056 pixel bytes per
round trip, so throughput and input latency need measurement on a live target.

Useful principles from the shared PythonOS/RubyOS RemoteOS-SDL service are
bounded binary transfers, ordered input acknowledgment, and per-operation
telemetry. Its JSON envelope and drawing-command protocol are not the agentOS
CC ABI. Frame and input operations here remain separate contracts.

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
