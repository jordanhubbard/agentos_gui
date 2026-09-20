# Raw batching control

`FRAME_RAW_BATCH=1 FRAME_REFERENCE=/path/to/noise.raw make benchmark-frame-transfer`
compares production packed batching with ordinary raw reads grouped under the
same 32,448-byte / 25 ms bounds. Reverse order with `BENCH_ORDER=packed-first`.
Wire-request counts are differences between the client's monotonic traffic
sequence numbers, sampled outside the timed read loops. No production behavior
was changed for this measurement.

On the retained Spark AArch64 guest, noise snapshot 3260 matched all 3 MiB of
reference pixels in both orders. Reference SHA-256 is
`b7ff18b33bda8310719e18451b78aef5610e1a4f7cb655576937bda700bfe2bf`.
The server image and fixture are those in agentOS PR #270's frame-pattern receipt.

| Order | Raw batch ms / wire requests | Packed ms / wire requests |
|---|---|---|
| raw first | 2911.27 / 776 | 3406.88 / 810 |
| packed first | 3862.56 / 776 | 3851.70 / 808 |

The adjacent JSON files retain complete results. The reverse-order timing is
effectively equal, so these samples do not prove a stable latency penalty
independent of scheduling. They do establish excess packed wire requests.
Code inspection identifies a batch-boundary contributor: packed raw prefixes
contain at most 4048 bytes, while batches request multiples of 4056 bytes.
A batch that survives its time budget can issue a small tail request. The
next experiment should avoid this redundant tail while preserving bounded
prefix progress, strict decoding, and input scheduling between batches.

Validation: `cargo check --example frame_transfer` and `make test-rust`
(14 tests) passed; both real-target comparisons passed. This is diagnostic
evidence, not a production performance fix or release acceptance.
