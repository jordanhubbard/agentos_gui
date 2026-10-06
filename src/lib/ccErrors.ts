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

// `cc_ipc::authority_err` (Rust) tags "the connected cc_pd does not
// recognize this opcode at all" (CC_ERR_BAD_SESSION on a sessionless call,
// which can only mean an older cc_pd that predates the opcode) with
// `io::ErrorKind::Unsupported`, which `commands.rs::map_cc_error` prefixes
// `NOT_SUPPORTED: `. This is distinct from NOT_PERMITTED (the running
// cc_pd knows the opcode but its operator envelope refuses it) and from an
// ordinary transport failure.
const NOT_SUPPORTED_PREFIX = 'NOT_SUPPORTED: ';

export function notSupportedReason(error: unknown): string | null {
  const text = typeof error === 'string' ? error : String(error);
  return text.startsWith(NOT_SUPPORTED_PREFIX)
    ? text.slice(NOT_SUPPORTED_PREFIX.length)
    : null;
}

/**
 * Render any `cc_ipc` failure as a short, specific reason: "not supported by
 * this cc_pd" vs. "refused by the operator authority envelope" vs. a plain
 * transport/protocol failure. Used by views (like the authority/topology
 * view) that must say why data is unavailable rather than silently falling
 * back to something that looks like real data.
 */
export function describeCcFailure(error: unknown): string {
  const notSupported = notSupportedReason(error);
  if (notSupported !== null) return `not supported by this cc_pd: ${notSupported}`;

  const notPermitted = notPermittedReason(error);
  if (notPermitted !== null) return `refused by the operator authority envelope: ${notPermitted}`;

  return typeof error === 'string' ? error : String(error);
}
