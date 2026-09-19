# Native capture-loss release during live display

The Spark native GUI at runtime source `ae21ece` passed the guest's exact
`--gui` evdev probe while live frames continued transferring. After F12
press/release, the host left button was held down. Escape released pointer
capture; the guest received BTN_LEFT up **before** the host mouseup was sent.
The probe printed `AGENTOS_GUI_INPUT_PASS keyboard=4 pointer=4` and exited zero.
It requires ordered down/SYN/up/SYN packets for both devices and rejects
trailing input during its 200 ms post-check.

The passing screenshot shows live capture at 3%, last completed frame 6701
(1.8 s), four acknowledged input batches, and pointer/keyboard focus released.
The host button was then released, live display stopped, and Alt+F4 closed
the application. GDB reported that the inferior exited normally.

No production code changed for this test. GUI binary SHA-256:
`19a55f77b7cda03581c1f02d568e6c648bd27ab4769157b6743ea61aaaab1bb5`.
The guest/server and original GUI-mode probe are those in the native-live-input
receipt. Artifacts and checksums are retained at
`/home/jkh/.local/share/agentos-evidence/2026-09-19-capture-release/`.

This qualifies ordinary capture loss while the client is alive. Abrupt socket
closure, GUI process death and precise input latency remain separate work.
The previous shutdown segmentation fault is still unresolved: four debugger
closures now exited normally, and host journal searches produced no backtrace.
MAC follow-up `task_8a2c2bce4cd20a3ce3cbc58fcb48f456` stages that diagnosis with
dispatch held; it is distinct from the historical SIGKILL investigation.
