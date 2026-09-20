# Tao shutdown dependency patch

`tao/` is the crates.io Tao 0.34.8 package, originally locked with checksum
`9103edf55f2da3c82aea4c7fab7c4241032bfeea0e71fa557d98e00e7ce7cc20`.
Its package metadata records source commit
`10b26c8712033af65c0721461590a57ec9549bbc` with a dirty build tree; the registry
package checksum is the source identity. Upstream licenses remain included.
This copy retains the library, documentation and licenses. Example programs,
their manifest entries and development dependencies, the package lockfile
and redundant original manifest are omitted. The application workspace
lockfile controls the remaining dependency resolution.

The local change is confined to the Linux X11 device-reader lifecycle:
`tao-shutdown.patch` records the source delta against the registry package.

- Own the reader thread and a private wake socket.
- Wake and join it before the event loop returns, including idle shutdown.
- Close its display on that thread, and free obtained X event cookies.
- Initialize event storage before handing it to Xlib.

The original retained core shows a reader inside `XNextEvent`/libXi/libXext
during process shutdown. This patch requires native input and shutdown
qualification; the core alone does not prove the patch fixes every crash.
`make test-x11-device-thread` checks idle wake/join and stop priority without
requiring an X server. The ordinary native GUI checks remain necessary.

Keep this patch separate from application input handling. Remove the override
when an upstream release with equivalent lifecycle handling is qualified.
