# Native pointer-lock repaint investigation

On Spark with WebKitGTK 2.52.6, GTK 3.24.41, Xvfb and Openbox, clicking
Capture pointer can stop visible updates until the window is resized.
The application's pointer state does update. A standalone GTK/WebKit program
reproduces the failure without Tauri, React, our Tao patch or any guest IPC.

Run the standalone reproduction on a test display:

```sh
LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  make diagnose-pointer-repaint
```

Click Capture pointer. Compare the rendered frame counter and status with the
JSON printed once per second. On the failing path the JSON says `locked:true`,
`hidden:false`, and reports an increasing animation-frame counter while the
window remains visibly unchanged. Resize the window to reveal the updated
state. Escape releases pointer lock; close the window to exit.

The reproduction also accepts `AGENTOS_REPRO_SOFTWARE=1` to select WebKit's
NEVER hardware-acceleration policy and `AGENTOS_REPRO_REDRAW=1` to request a
GTK redraw on each diagnostic message. Neither resolved the observed failure.
The production application's `WEBKIT_DISABLE_COMPOSITING_MODE=1` experiment
also failed. These are diagnostic switches, not recommended workarounds.

Evidence is retained in
`/home/jkh/.local/share/agentos-evidence/2026-09-19-x86-ownership/gui-pointer-repaint`.
The source and screenshots establish a failure outside the application;
they do not identify the precise WebKit/GTK/X11 cause or prove a fix. Physical
display and Wayland behavior remain untested.
