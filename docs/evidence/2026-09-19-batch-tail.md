# Packed batch tail correction

GUI source `ae8bc44` stops a large, non-final batch before a small residual
wire request. The next batch combines those pixels with the following data.
Small explicit reads, final-frame completion, strict decoding, immutable
snapshot checks, and the 25 ms scheduling budget are preserved.

On retained Spark snapshot 3492, both transfer orders matched the complete
3,145,728-byte noise reference. Packed requests fell from 808–810 in the
preceding control to 778 in both orders, the minimum for 4048-byte prefixes.
Raw requests remained 776. Adjacent JSON records retain complete results.

| Order | Raw batch ms | Packed batch ms |
|---|---|---|
| raw first | 3195.57 | 4013.57 |
| packed first | 3498.81 | 2977.70 |

This establishes lower request overhead, not a stable latency improvement:
elapsed times vary substantially with order and target scheduling.

The new wire-level regression checks exact request offsets and full recovery
of a 32,768-byte frame across the deferred boundary. All 15 Rust tests,
129 browser tests, TypeScript checks, and Rust all-target checks passed.
The noise fixture restored text mode and its SSH session exited zero.

Gradient snapshot 3518 also matched every reference byte: packed transfer took
2419.03 ms / 576 requests, raw 3147.95 ms / 776 requests. The rebuilt native GUI
rendered the full gradient at that sequence and displayed 3.0 s capture time.
Native binary SHA-256:
`907842d460fdc763ed4cbacc28d01c67ee0a88915a7432eee8a12ba915bfa3ca`.
`make build` passed. The native window closed normally with exit zero.
