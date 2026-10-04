# Spark input-stage timing, 2026-09-19

The optional stage logger and SSH measurement control are at `8e2652c`;
the guest control helper is agentOS `7ec8cb8`. The instrumented native binary
SHA256 is `b262a14cfce12a8fb565e854694585b9f77c29d104f85d0580d2e91236ad7067`.
The existing agentOS image and guest remained unchanged. Measurement command
usage and scope are in [native-input-latency.md](native-input-latency.md).

Twenty native key transitions passed the guest's complete-packet, ordering
and trailing-event assertions during live display. SSH exited zero. The host
receipt upper-bound median was 532.353 ms, p95 795.680 ms, maximum 1007.064 ms.
The corresponding twenty backend records measured:

| Stage | Minimum | Median | Maximum |
| --- | --- | --- | --- |
| Blocking-worker/shared-socket wait | 0.009 ms | 4.981 ms | 155.301 ms |
| Input request and validated acknowledgment | 1.333 ms | 2.160 ms | 4.030 ms |

These backend measurements start after the frontend invokes Tauri. They do
not measure frontend scheduling or guest evdev delivery. A valid protocol
acknowledgment alone does not establish delivery; the separate probe does.

The SSH-only echo control passed all twenty receipts with refresh stopped:
median 345.498 ms, p95 521.052 ms, maximum 521.066 ms. A live-refresh control
after browser tests finished passed with median 579.259 ms, p95 2102.693 ms,
maximum 2102.707 ms. An earlier live control overlapped browser tests and is
retained as `agentos-input-ssh-control-live.*`, not used for this comparison.

The SSH control overlaps native-input receipt timings even though it injects
no input. It demonstrates substantial measurement-channel delay, not the
one-way return-path contribution. Do not subtract these medians to infer
one-way input latency or attribute the full receipt delay to the GUI. The
socket request itself was a small part of the measured interval; the 155 ms
maximum connection wait remains visible and is not declared acceptable by
this investigation. Input-to-render latency remains unmeasured.

Validation: all 15 Rust tests, native release build, typecheck, Cargo check,
example check, core host tests and all 130 browser tests passed. The native
GUI closed normally after the measurements. The stage logger is disabled by
default and records no key values. No OS scheduling or input policy changed.

Logs, JSON samples, screenshots and hashes are retained under
`/home/jkh/.local/share/agentos-evidence/2026-09-19-input-stage-timing/`.
