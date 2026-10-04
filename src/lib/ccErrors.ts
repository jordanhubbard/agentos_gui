// `cc_pd`'s operator authority envelope deliberately refuses snapshot,
// restore, fault-injection and trace commands under an untrusted-operator
// threat model (snapshot reads guest RAM in full and is an exfiltration
// primitive, fault injection is an attack tool, trace is debug surface).
// The Rust backend tags that refusal by prefixing the error string with
// `NOT_PERMITTED: ` (see src-tauri/src/commands.rs::map_cc_error, which
// keys off io::ErrorKind::PermissionDenied set by
// src-tauri/src/cc_ipc.rs::status_err for CC_ERR_NOT_PERMITTED).
//
// This lets the UI tell "cc_pd refused this on purpose, by policy" apart
// from a transport or protocol fault, and react by disabling the specific
// control with a message naming the reason — instead of treating every
// failure the same way (or hiding the control, which would hardcode a
// policy this client cannot observe: the envelope is defined by the
// running cc_pd, not by the GUI).
const NOT_PERMITTED_PREFIX = 'NOT_PERMITTED: ';

export function notPermittedReason(error: unknown): string | null {
  const text = typeof error === 'string' ? error : String(error);
  return text.startsWith(NOT_PERMITTED_PREFIX)
    ? text.slice(NOT_PERMITTED_PREFIX.length)
    : null;
}
