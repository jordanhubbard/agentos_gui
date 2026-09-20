# Native wheel detent correction on Spark

GUI source `ae21ece` passed the complete guest evdev fixture while live display
was active. The authenticated SSH probe exited zero and printed:

```
AGENTOS_GUI_POINTER_PASS key=F12 x=17 y=-9 wheel=1 button=left packets=complete
```

This checks exact ordered motion/wheel/button values, F12 down/up, nonempty
SYN-terminated packets and no trailing events for 200 ms. GUI batching may
group adjacent transitions. The retained server is packed runtime `a9391b0`;
guest probe source is agentOS `19f9809`, SHA-256
`3f20a0d9ac57e4bbb70d562807eded7b51349ec78e5f3109a622dffe19bca6b8`.
Native GUI SHA-256:
`19a55f77b7cda03581c1f02d568e6c648bd27ab4769157b6743ea61aaaab1bb5`.

Temporary source-event instrumentation measured a physical X11 wheel-up event
as pixel-mode deltaY=-84 and wheelDeltaY=120. The old 100-pixel divisor retained
0.84 without emitting a detent. This explains the preceding one-click failure
and extra events in the three-click probe. The diagnostic patch and output are
retained; the logging command and frontend hook were removed before this fix.

The corrected conversion uses optional, finite, nonzero whole multiples of
120 only for trusted pixel-mode events with consistent directions. Fractional,
untrusted, missing-field and inconsistent-sign cases retain the unit-aware
accumulator. No browser identity or Spark-specific pixel scale is hardcoded.
WebKit's [WheelEvent constructor](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/WheelEvent.cpp)
derives the legacy fields from platform wheel ticks; its
[tick multiplier](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/dom/WheelEvent.h)
is 120. Other host/browser and physical high-resolution device qualification
remains separate; browser tests preserve fractional accumulation and reset.

Validation: `make check`, all 130 browser tests and `make build` passed.
The native sequence used actual pointer capture, xdotool relative motion,
one wheel-up click and a left click. The passing screenshot shows live frame
transfer at 73%, last completed sequence 6160 (1.6 s), focus/capture active,
and six acknowledged input batches. Initial automation used a stale X11
window ID, returned BadWindow and was corrected before input injection;
the guest log independently records the passing sequence.

Three debugger runs (qualified binary, then two diagnostic builds) exited
normally after live display and pointer use. No crash backtrace was obtained.
This does **not** resolve the preceding native shutdown segmentation fault.
Precise input latency, abrupt-disconnect recovery, final integrated revision
qualification and release readiness remain unproven.

Artifacts and manifests are retained under
`/home/jkh/.local/share/agentos-evidence/2026-09-19-wheel-diagnosis/` and
`/home/jkh/.local/share/agentos-evidence/2026-09-19-wheel-fixed/`.
