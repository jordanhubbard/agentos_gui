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

## Remaining integration

This bridge is not yet a desktop viewer. The next layer must consume immutable
frame captures, release their cookies, reject stale work after reconnect or
guest replacement, render XRGB8888 pixels, and manage keyboard/pointer focus.
The observer contract currently requires reads of at most 4056 pixel bytes per
round trip, so throughput and input latency need measurement on a live target.

Useful principles from the shared PythonOS/RubyOS RemoteOS-SDL service are
bounded binary transfers, ordered input acknowledgment, and per-operation
telemetry. Its JSON envelope and drawing-command protocol are not the agentOS
CC ABI. Frame and input operations here remain separate contracts.

Validation of this bridge uses Unix socket pairs and exact request/reply
bytes. These host tests do not prove input delivery into a running guest;
that requires a GUI-to-agentOS target test after the viewer is connected.
Run `make test-rust`, `make check`, and `make test`; `make build` validates
the native release executable. Linux builds need GTK 3 and WebKitGTK 4.1
development packages. macOS keeps its app bundle, while Linux builds the
executable used by `make run` without an installer by default.
