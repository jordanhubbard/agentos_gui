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

## MIT-SHM comparison

Two fresh Xvfb displays were started with the same 1440x1200x24 screen,
Openbox, diagnostic binary and application environment. Display `:3` used
`-extension MIT-SHM`; display `:4` retained the default MIT-SHM extension.
`xdpyinfo -queryExtensions` confirmed the extension difference.

With MIT-SHM disabled, pointer capture visibly changed the status to
`captured`; screenshots showed JavaScript frames advancing from 1565 to 2349
and native Cairo draws advancing from 1512 to 2269 without any window resize.
With MIT-SHM enabled, the control retained `outside`, frame 673 and native
draw 602 while its log reported `locked:true` and more than 1300 callbacks.
This is a successful environment workaround for the standalone reproduction,
not yet a library fix or proof about physical displays.

The bounded diagnostic display command is:

```sh
Xvfb :3 -screen 0 1440x1200x24 -nolisten tcp -extension MIT-SHM
```

Use an unused display number. This does not change an existing desktop's
configuration. Screenshots and logs are retained under `standalone/` as
`agentos-no-shm*`, `agentos-webkit-no-shm.log`, `agentos-shm-control.png`, and
`agentos-webkit-shm-control.log`.

Additional negative controls: disabling GTK double buffering, `GDK_GL=disable`,
`gdk_display_flush`, and `XSync` did not restore presentation. Cairo clip extents
remained the full window after capture and reported success. Direct Xlib text
drawing reached the screen while GTK/Cairo output remained stale, although
that diagnostic itself also disturbed pre-capture rendering. Its result alone
must not be treated as a faithful reproduction of the original trigger.

The production GUI was then tested on display `:3` against the retained real
Debian guest (`agentos-qemu-wOmInT`, OS revision `cd9efb9`). The unchanged GUI
binary SHA-256 was
`6bda035523d29bf2b31e36d6686f775ff7e61d27fe2c1c6a4c7a30577ab8dbd8`.
Launched through `make run` with the guest's CC-PD socket, it displayed the
1024x768 guest console. Capture visibly updated the focus border and
`Pointer captured` status without a resize. While captured, completed guest
frames advanced from 20855 to 20892. Escape visibly restored `Pointer is
outside the guest` and removed the focus border. The app was closed normally.
The `agentos-gui-no-shm-*` screenshots and log are archived in the parent
evidence directory. This verifies the workaround in the actual application;
it does not requalify input delivery, latency, physical displays, or the final
integrated release revision.

## Private Cairo upgrade control

An isolated build of unmodified Cairo 1.18.4 also reproduced the failure on
the MIT-SHM-enabled display `:4`. The official source archive SHA-256 was
`445ed8208a6e4823de1226a74ca319d3600e83f6369f99b14265006599c32ccb`.
Meson 1.5.2 configured a release build with tests disabled and a private
installation prefix; no system libraries were replaced. The unchanged
standalone diagnostic ran with that prefix in `LD_LIBRARY_PATH`, software GL,
DMA-BUF disabled, and its native Cairo overlay and redraw counter enabled.
The process's `/proc` mappings confirmed it loaded the private `libcairo`.

After capture, two screenshots retained `outside`, JavaScript frame 1465
and native Cairo draw 1385, while the log advanced from JavaScript frame
2558 / native draw 2470 to frame 3306 / draw 3193 with `locked:true`.
This rules out upgrading to this Cairo release as a sufficient fix for the
tested configuration. It does not identify which library causes the failure.
The diagnostic was closed normally. Build logs, library mappings, diagnostic
output and screenshots are archived in `cairo-1.18.4/` beneath the evidence
directory above.
