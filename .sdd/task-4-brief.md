### Task 4: Leave something behind that catches the next drift

**Files:** `src-tauri/src/cc_ipc.rs` (tests), `README.md`

A four-month break went unnoticed because nothing checks this client against the server it talks to.

- [ ] **Step 1:** Add a Rust test that locates the agentOS tree if present (sibling `../agentos`, or `AGENTOS_SRC`), parses the `MSG_CC_*` opcode definitions out of `kernel/agentos-root-task/include/agentos.h`, and asserts the GUI's re-declared constants match. When the tree is absent, the test must **skip with a clear message**, not pass silently — a guard that quietly no-ops is worse than none.
- [ ] **Step 2:** Extend it to the handshake constants it can reach the same way: `CC_CONNECTION_VERSION`, the wire frame sizes, and `CC_OPERATOR_TOKEN_BYTES`.
- [ ] **Step 3:** Document in `README.md` how to run it and what it protects, stating plainly that the constants are re-declared by design and this test is what keeps the duplication honest.
- [ ] **Step 4:** Demonstrate it works: temporarily change one re-declared opcode, show the test fails, restore, show it passes. Paste all three outputs.
- [ ] **Step 5:** Commit.

---

