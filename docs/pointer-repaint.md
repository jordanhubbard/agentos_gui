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

The diagnostic also prints the GTK frame-clock counter. In the failing run
both that counter and the JavaScript animation counter continued advancing
after pointer capture. A stopped GTK frame clock therefore does not explain
this reproduction; the visible pixels still remained stale.
The `draws` counter also keeps increasing, so GTK draw callbacks themselves
are not stopped.

Set `AGENTOS_REPRO_SNAPSHOT=/tmp/pointer-content.png` to save one WebKit content
snapshot after the first successful capture. The snapshot callback must print
`snapshot_status=0`. In the observed failure, that PNG correctly says
`captured` and shows a newer frame counter, while both a root-window screenshot
and a direct native-window screenshot retain the old `outside` frame.
This narrows the discrepancy to native presentation rather than document
state or WebKit's snapshot rendering. Taking the snapshot does not repair the
visible window.

A native Cairo overlay narrows this further. Set `AGENTOS_REPRO_PAINT=1`
with `AGENTOS_REPRO_REDRAW=1` to draw a colored square and the current draw
counter after WebKit's draw callback. In the recorded run, two screenshots
retained JavaScript frame 809 and native Cairo counter 783 while the diagnostic
log advanced beyond 1,500 GTK draws. Both WebKit content and the additional
native drawing therefore stopped reaching the screen. A separate capture and
release cycle also showed that Escape released the lock in JavaScript but did
not restore visible updates. This rules out a failure limited to WebKit's
document pixels; it does not yet distinguish GTK buffering from X11 presentation.
Screenshots and logs are archived under `standalone/agentos-cairo-count-*` and
`standalone/agentos-webkit-cairo-count.log` in the evidence directory below.

The reproduction also accepts `AGENTOS_REPRO_SOFTWARE=1` to select WebKit's
NEVER hardware-acceleration policy and `AGENTOS_REPRO_REDRAW=1` to request a
GTK redraw on each diagnostic message. Neither resolved the observed failure.
The production application's `WEBKIT_DISABLE_COMPOSITING_MODE=1` experiment
also failed. These are diagnostic switches, not recommended workarounds.
Enabling DMA-BUF explicitly with `WEBKIT_DISABLE_DMABUF_RENDERER=0` and a
separate local variant omitting the canvas focus call also reproduced the
failure; neither is a fix.

Evidence is retained in
`/home/jkh/.local/share/agentos-evidence/2026-09-19-x86-ownership/gui-pointer-repaint`.
The source and screenshots establish a failure outside the application;
they do not identify the precise WebKit/GTK/X11 cause or prove a fix. Physical
display and Wayland behavior remain untested.
