# Native keyboard delivery measurement

`make benchmark-native-input BENCH_SSH_ARGS='...'` measures the real X11
keyboard path through the running native GUI to Linux guest evdev. Build
agentOS's `make guest-input-probe` and copy that executable into the guest.
End the SSH arguments with `HOST /path/to/probe --gui-latency`; use pinned
host keys and the existing authorized guest key. Focus a rendered GUI guest
display before invoking the benchmark, and begin with no held keys.

The guest discovers and grabs the canonical keyboard and pointer devices.
It accepts exactly ten F12 down/up pairs, each transition in a complete
SYN_REPORT packet, and rejects repeats, pointer events, incorrect values,
order changes and trailing events. It flushes an ordered receipt after each
packet. The host sends each brief pair with `xdotool key F12`, waits for both
receipts and inserts a 100 ms gap before the next pair. It releases F12 on
failure and bounds readiness, packet receipt and process completion waits.

Each sample starts immediately before launching xdotool and ends when the
host reader receives the corresponding validated guest receipt over SSH.
Both transitions in a pair share the start time. Results are **upper bounds**
on key delivery, including process startup, host scheduling, GUI processing,
CC transport, guest scheduling and the SSH return path. They neither require
clock synchronization nor measure one-way latency. Paired samples are
correlated; twenty samples are not a performance distribution qualification.
The final guest quiet-period check runs outside the timed intervals.

On Spark, 2026-09-19, the production GUI runtime `ae21ece` with packed-frame
agentOS runtime `a9391b0` passed all twenty transitions with refresh running
and stopped. The first live pass measured median 553.894 ms, p95 667.619 ms,
maximum 1269.621 ms. The stopped-refresh control measured median 355.786 ms,
p95 469.041 ms, maximum 469.055 ms. These do not isolate the cause of the
difference or establish acceptable one-way desktop response.
A second live pass after the stopped-refresh control passed all transitions,
with median 524.200 ms, p95 556.915 ms and maximum 1232.137 ms. Its screenshot
shows live capture at 49%, frame 11519, 1.6 s capture time and 90 cumulative
input batches acknowledged. The native app subsequently closed normally.

Harness source: GUI `7990ffc`, guest probe agentOS `12069b7`.
The guest probe SHA256 is
`f05a26453253b91708134bd8a3a3b4a492b9a5eb06b55b7b78911b7bf3ee5908`.
Raw samples, stderr, build/check logs, screenshots and rejected attempts are
retained under
`/home/jkh/.local/share/agentos-evidence/2026-09-19-native-input-latency/`.
The initial held-key recipe was rejected for autorepeat; a subsequent run
received all packets but exceeded an overly short final assertion deadline.
Neither is counted as a successful pass.
