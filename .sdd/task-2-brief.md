### Task 2: Close the hardening gaps

**Files:** `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `package.json`, `src-tauri/src/commands.rs`

- [ ] **Step 1: Content Security Policy.** `tauri.conf.json` has `"csp": null`. Set a restrictive policy — at minimum `default-src 'self'`, no `unsafe-inline`, no wildcard origins. Then run the app and the Playwright suite: a CSP that breaks the UI is not shippable, and one that permits `unsafe-inline` closes nothing. Report the exact policy you settled on and what you had to allow.
- [ ] **Step 2: Scope the Tauri capability set.** `capabilities/default.json` grants `core:default` over a 29-command surface. Enumerate the commands the UI actually invokes (grep `invoke(` in `src/`) and grant only those. Verify every UI path still works — narrowing permissions fails at runtime, not compile time.
- [ ] **Step 3: Remove `@tauri-apps/plugin-shell`.** It is declared in `package.json`, registered nowhere in `lib.rs`, and granted nothing. Inert today, one line from being an arbitrary-execution surface in a window that speaks to the OS control socket. Remove the dependency and confirm nothing imports it.
- [ ] **Step 4: Validate the socket path in Rust.** `cc_connect` accepts an arbitrary path string from the frontend and opens it. Restrict it: accept only a path the backend resolved itself (the `CC_PD_SOCK` env var, the sibling-repo default, or an explicit user selection), and reject anything else with a clear error. The frontend must not be able to point the backend at an arbitrary Unix socket.
- [ ] **Step 5:** Run `npm run check` and the Playwright suite. Commit.

---

