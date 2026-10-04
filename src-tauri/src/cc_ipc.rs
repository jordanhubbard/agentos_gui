//! agentOS CC-PD IPC client
//!
//! Wire protocol (from agentctl_ng.c / cc_contract.h):
//!   Request:  opcode(4) + mr[3](12) + shmem(4096) = 4112 bytes
//!   Reply:    mr[4](16) + shmem(4096) = 4112 bytes
//!
//! Transport: Unix domain socket at CC_PD_SOCK (default: build/cc_pd.sock)
//! All MSG_CC_* constants mirror agentos.h exactly.
//!
//! Connection bootstrap (cc_contract.h, "Binary socket bootstrap"):
//! `cc_pd` sends an unprompted 4112-byte greeting the instant the socket is
//! open (magic + version + a 64-bit generation that increments every time
//! the transport resets). The client must reply with a single
//! `MSG_CC_CONNECTION_SYNC` request before sending anything else, echoing
//! the version and generation it was just sent and carrying the operator
//! credential in the first `CC_OPERATOR_TOKEN_BYTES` of shmem (the rest
//! zero). Only after `cc_pd` replies `CC_OK` is the connection active and
//! `MSG_CC_CONNECT` (session establishment) or any sessionless opcode
//! (`MSG_CC_INSPECT`, `MSG_CC_AUTHORITY`, `MSG_CC_OPERATOR_*`) permitted.
//! A version, generation, credential, or reserved-byte mismatch makes
//! `cc_pd` close the connection *without replying* — the client observes
//! EOF or a read timeout, not an error opcode.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// ── MSG_CC_* opcodes (from agentos.h) ────────────────────────────────────────
pub const MSG_CC_CONNECT: u32 = 0x2601;
pub const MSG_CC_DISCONNECT: u32 = 0x2602;
pub const MSG_CC_SEND: u32 = 0x2603;
pub const MSG_CC_RECV: u32 = 0x2604;
pub const MSG_CC_STATUS: u32 = 0x2605;
pub const MSG_CC_LIST: u32 = 0x2606;
pub const MSG_CC_LIST_GUESTS: u32 = 0x2607;
pub const MSG_CC_LIST_DEVICES: u32 = 0x2608;
pub const MSG_CC_LIST_POLECATS: u32 = 0x2609;
pub const MSG_CC_GUEST_STATUS: u32 = 0x260A;
pub const MSG_CC_DEVICE_STATUS: u32 = 0x260B;
pub const MSG_CC_ATTACH_FRAMEBUFFER: u32 = 0x260C;
pub const MSG_CC_SEND_INPUT: u32 = 0x260D;
pub const MSG_CC_SNAPSHOT: u32 = 0x260E;
pub const MSG_CC_RESTORE: u32 = 0x260F;
pub const MSG_CC_LOG_STREAM: u32 = 0x2610;
pub const MSG_CC_CREATE_GUEST: u32 = 0x2611;
pub const MSG_CC_FAULT_INJECT: u32 = 0x2612;
pub const MSG_CC_SUSPEND_GUEST: u32 = 0x2613;
pub const MSG_CC_RESUME_GUEST: u32 = 0x2614;
pub const MSG_CC_DESTROY_GUEST: u32 = 0x2615;
pub const MSG_CC_TRACE_START: u32 = 0x2616;
pub const MSG_CC_TRACE_STOP: u32 = 0x2617;
pub const MSG_CC_TRACE_QUERY: u32 = 0x2618;
pub const MSG_CC_TRACE_DUMP: u32 = 0x2619;
pub const MSG_CC_CONNECTION_SYNC: u32 = 0x261F;
pub const MSG_CC_AUTHORITY: u32 = 0x2620;

// ── Connection bootstrap constants (cc_contract.h) ───────────────────────────
// Source of truth in the agentOS tree: kernel/agentos-root-task/include/
// contracts/cc_contract.h (magic/version/CC_OK) and
// kernel/agentos-root-task/include/cc_operator_credential.h (token length
// and the well-known development value). This repo re-declares them by
// design — see README.md — and does NOT build against that tree.
pub const CC_CONNECTION_MAGIC: u32 = 0x4343_5244;
pub const CC_CONNECTION_VERSION: u32 = 1;
pub const CC_OK: u32 = 0;
pub const CC_OPERATOR_TOKEN_BYTES: usize = 32;

/// `cc_pd`'s status code for a deliberate operator-authority-envelope
/// refusal (as opposed to a transport fault or an unrelated protocol
/// error). The envelope is defined and enforced entirely by the running
/// `cc_pd`; this constant only lets us recognize its refusal and surface it
/// distinctly instead of flattening it into a generic error.
pub const CC_ERR_NOT_PERMITTED: u32 = 11;

/// Build an `io::Error` for a non-OK `cc_pd` status reply.
///
/// A `CC_ERR_NOT_PERMITTED` refusal is reported with
/// `io::ErrorKind::PermissionDenied` so callers (see `commands.rs`) can
/// mechanically distinguish "cc_pd's operator authority envelope refused
/// this on purpose" from any other failure, without parsing message text.
/// Every other non-OK status keeps the existing generic `ErrorKind::Other`
/// shape.
fn status_err(context: &str, ok: u32) -> io::Error {
    if ok == CC_ERR_NOT_PERMITTED {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{context} refused by the operator authority envelope (CC_ERR_NOT_PERMITTED)"),
        )
    } else {
        io::Error::new(io::ErrorKind::Other, format!("{context} err {ok}"))
    }
}

// ── Authority snapshot ABI (platform/include/platform/authority.h) ──────────
//
// A ledger of what the root task recorded granting to each protection
// domain at boot, by capability kind. seL4 exposes no capability-
// enumeration syscall (seL4_DebugCapIdentify is CONFIG_DEBUG_BUILD-only and
// disabled in the shipped release kernel), so this is NOT a reading of live
// kernel state and it does NOT verify the subsetting invariant -- the
// kernel enforces that unconditionally and independently. It is a
// boot-time record, nothing more.
//
// Re-declared here by design (see README.md) from the agentOS tree's
// platform/include/platform/authority.h and
// kernel/agentos-root-task/include/contracts/cc_contract.h. Note this is
// NOT the layout a literal reading of the task description would suggest
// (name[48], 80-byte rows): the actual struct is `__attribute__((packed))`
// with a 32-byte name field, giving 60-byte rows. Verified directly against
// the agentOS source (platform/include/platform/authority.h) rather than
// inferred.
pub const AOS_AUTHORITY_VERSION: u32 = 1;
pub const AOS_AUTHORITY_MAX_PDS: usize = 32;
pub const AOS_AUTHORITY_NAME_LEN: usize = 32;
pub const AOS_AUTHORITY_KIND_COUNT: usize = 11;

/// Sentinel `pd_index` for the root task's own row (R16): root's initial
/// capabilities would otherwise collide with descriptor index 0
/// (`nameserver`) and be silently merged into its row. Render this row as
/// "the root task," never as a domain with an absurd numeric index.
pub const AOS_AUTHORITY_ROOT_PD_INDEX: u32 = 0xFFFF_FFFF;

/// Capability kind order is ABI (platform/include/platform/authority.h) --
/// append only, never reorder.
pub const AUTHORITY_KIND_NAMES: [&str; AOS_AUTHORITY_KIND_COUNT] = [
    "untyped",
    "tcb",
    "endpoint",
    "notification",
    "cnode",
    "frame",
    "vspace",
    "irq_handler",
    "sched_context",
    "reply",
    "other",
];

const AUTHORITY_HEADER_LEN: usize = 24;
// pd_index(4) + name(32) + counts(11 * 2 = 22) + reserved(2) = 60, no
// alignment padding: the C struct is `__attribute__((packed))`.
const AUTHORITY_ROW_LEN: usize = 4 + AOS_AUTHORITY_NAME_LEN + AOS_AUTHORITY_KIND_COUNT * 2 + 2;
const AUTHORITY_SNAPSHOT_LEN: usize = AUTHORITY_HEADER_LEN + AOS_AUTHORITY_MAX_PDS * AUTHORITY_ROW_LEN;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorityRow {
    pub pd_index: u32,
    /// True for the root task's sentinel row (`pd_index == 0xFFFFFFFF`).
    pub is_root: bool,
    /// Decoded from a 32-byte NUL-padded (not NUL-terminated) field.
    /// Rendered as-is -- including any upstream truncation already baked
    /// into the recorded name -- never reconstructed or guessed.
    pub name: String,
    /// One count per `AUTHORITY_KIND_NAMES` entry, same order.
    pub counts: [u16; AOS_AUTHORITY_KIND_COUNT],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthoritySnapshot {
    pub version: u32,
    pub pd_count: u32,
    pub total_recorded: u32,
    pub truncated_adds: u32,
    pub saturated: bool,
    pub rows: Vec<AuthorityRow>,
}

/// Parse a raw `aos_authority_snapshot_t` out of reply shmem. Validates
/// `version` and bounds `pd_count` to `AOS_AUTHORITY_MAX_PDS` before
/// indexing anything -- a malformed or hostile `cc_pd` must not be able to
/// walk this client off the end of the buffer.
fn parse_authority_snapshot(shmem: &[u8]) -> io::Result<AuthoritySnapshot> {
    if shmem.len() < AUTHORITY_HEADER_LEN {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "authority snapshot shorter than its {AUTHORITY_HEADER_LEN}-byte header \
                 ({} bytes received)",
                shmem.len()
            ),
        ));
    }

    let version = u32::from_le_bytes(shmem[0..4].try_into().unwrap());
    if version != AOS_AUTHORITY_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "authority snapshot version {version} does not match the \
                 version this client understands ({AOS_AUTHORITY_VERSION})"
            ),
        ));
    }

    let pd_count_raw = u32::from_le_bytes(shmem[4..8].try_into().unwrap());
    if pd_count_raw as usize > AOS_AUTHORITY_MAX_PDS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "authority snapshot pd_count {pd_count_raw} exceeds the ABI \
                 maximum of {AOS_AUTHORITY_MAX_PDS}"
            ),
        ));
    }
    let pd_count = pd_count_raw as usize;

    let total_recorded = u32::from_le_bytes(shmem[8..12].try_into().unwrap());
    let truncated_adds = u32::from_le_bytes(shmem[12..16].try_into().unwrap());
    let saturated = u32::from_le_bytes(shmem[16..20].try_into().unwrap()) != 0;
    // shmem[20..24] is reserved.

    let rows_end = AUTHORITY_HEADER_LEN + pd_count * AUTHORITY_ROW_LEN;
    if shmem.len() < rows_end {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "authority snapshot truncated: pd_count {pd_count} needs \
                 {rows_end} bytes, only {} received",
                shmem.len()
            ),
        ));
    }

    let mut rows = Vec::with_capacity(pd_count);
    for i in 0..pd_count {
        let base = AUTHORITY_HEADER_LEN + i * AUTHORITY_ROW_LEN;
        let row = &shmem[base..base + AUTHORITY_ROW_LEN];

        let pd_index = u32::from_le_bytes(row[0..4].try_into().unwrap());

        // NUL-padded, not NUL-terminated: find the first NUL (there is
        // always one, since the source zero-fills the field) and render
        // only the bytes before it, lossily -- never assume this is a
        // well-formed C string beyond that bound.
        let name_bytes = &row[4..4 + AOS_AUTHORITY_NAME_LEN];
        let nul_at = name_bytes.iter().position(|&b| b == 0).unwrap_or(name_bytes.len());
        let name = String::from_utf8_lossy(&name_bytes[..nul_at]).into_owned();

        let counts_off = 4 + AOS_AUTHORITY_NAME_LEN;
        let mut counts = [0u16; AOS_AUTHORITY_KIND_COUNT];
        for (k, slot) in counts.iter_mut().enumerate() {
            let o = counts_off + k * 2;
            *slot = u16::from_le_bytes(row[o..o + 2].try_into().unwrap());
        }

        rows.push(AuthorityRow {
            pd_index,
            is_root: pd_index == AOS_AUTHORITY_ROOT_PD_INDEX,
            name,
            counts,
        });
    }

    Ok(AuthoritySnapshot {
        version,
        pd_count: pd_count_raw,
        total_recorded,
        truncated_adds,
        saturated,
        rows,
    })
}

/// Map a non-OK `cc_pd` status from `MSG_CC_AUTHORITY` to a distinct error.
///
/// `CC_ERR_BAD_SESSION` (2) is cc_dispatch's fallthrough `default:` case for
/// an opcode it does not recognize at all -- and since this call carries no
/// session (it is sessionless, like INSPECT), a session-related error here
/// can only mean the connected `cc_pd` predates `MSG_CC_AUTHORITY` and does
/// not know the opcode. Reported as `io::ErrorKind::Unsupported` so callers
/// (see `commands.rs`) can tell that apart from `CC_ERR_NOT_PERMITTED`
/// (envelope refusal) and from an ordinary transport failure, instead of
/// flattening all three into one generic message.
const CC_ERR_BAD_SESSION: u32 = 2;

fn authority_err(ok: u32) -> io::Error {
    if ok == CC_ERR_BAD_SESSION {
        io::Error::new(
            io::ErrorKind::Unsupported,
            "cc_pd did not recognize MSG_CC_AUTHORITY; the connected cc_pd \
             likely predates this opcode",
        )
    } else {
        status_err("authority", ok)
    }
}

// ── Device type constants (CC_DEV_TYPE_*) ────────────────────────────────────
pub const CC_DEV_TYPE_SERIAL: u32 = 0;
pub const CC_DEV_TYPE_NET: u32 = 1;
pub const CC_DEV_TYPE_BLOCK: u32 = 2;
pub const CC_DEV_TYPE_USB: u32 = 3;
pub const CC_DEV_TYPE_FB: u32 = 4;
pub const CC_DEV_TYPE_COUNT: u32 = 5;

// ── Session constants (CC_SESSION_STATE_*, CC_CMD_TYPE_*) ───────────────────
pub const CC_CMD_TYPE_QUERY: u32 = 0x01;
pub const CC_CMD_TYPE_ACTION: u32 = 0x02;
pub const CC_CMD_TYPE_STREAM: u32 = 0x03;

pub const CC_SESSION_STATE_CONNECTED: u32 = 0;
pub const CC_SESSION_STATE_IDLE: u32 = 1;
pub const CC_SESSION_STATE_BUSY: u32 = 2;
pub const CC_SESSION_STATE_EXPIRED: u32 = 3;

// ── Wire frame sizes ──────────────────────────────────────────────────────────
const CC_SHMEM_SIZE: usize = 4096;
const CC_REQ_SIZE: usize = 4 + 12 + CC_SHMEM_SIZE; // 4112
const CC_REPLY_SIZE: usize = 16 + CC_SHMEM_SIZE; // 4112
const CC_GREETING_SIZE: usize = CC_REPLY_SIZE; // same wire shape as a reply: mr[4] + shmem
const CC_IO_TIMEOUT: Duration = Duration::from_secs(5);
const CC_TRAFFIC_MAX: usize = 512;
const CC_TRACE_ENTRY_SIZE: usize = 16;

/// Well-known development operator credential, hex-encoded (32 bytes / 64
/// hex chars). NOT a secret — see cc_operator_credential.h: agentOS treats
/// the local operator as untrusted and assumes they can read it. It selects
/// an authority envelope; it does not authenticate anyone. ASCII decode:
/// "agentOS-dev-operator-token-v1" + 3 trailing zero bytes.
const CC_DEV_OPERATOR_TOKEN_HEX: &str =
    "6167656e744f532d6465762d6f70657261746f722d746f6b656e2d7631000000";

// ── Serde types for Tauri ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuestInfo {
    pub guest_handle: u32,
    pub state: u32,
    pub os_type: u32,
    pub arch: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub dev_type: u32,
    pub dev_handle: u32,
    pub state: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuestStatus {
    pub guest_handle: u32,
    pub state: u32,
    pub os_type: u32,
    pub arch: u32,
    pub device_flags: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoecatStatus {
    pub total: u32,
    pub busy: u32,
    pub idle: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: u32,
    pub state: u32,
    pub client_badge: u32,
    pub ticks_since_active: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionStatus {
    pub session_id: u32,
    pub state: u32,
    pub pending_responses: u32,
    pub ticks_since_active: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSendResult {
    pub ok: u32,
    pub resp_pending: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecvResult {
    pub ok: u32,
    pub len: u32,
    pub text: String,
    pub hex: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceStatusInfo {
    pub dev_type: u32,
    pub dev_handle: u32,
    pub state: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapResult {
    pub snap_lo: u32,
    pub snap_hi: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuestCreateRequest {
    pub os_type: u32,
    pub arch: u32,
    pub ram_mb: u32,
    pub device_flags: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuestCreateResult {
    pub handle: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputEvent {
    pub event_type: u32,
    pub keycode: u32,
    pub dx: i32,
    pub dy: i32,
    pub btn_mask: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaultInjectResult {
    pub result: u32,
    pub ticks_to_recovery: u32,
    pub trace_event_id: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuestLifecycleResult {
    pub ok: u32,
    pub state: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceStatus {
    pub ok: u32,
    pub event_count: u32,
    pub bytes_used: u32,
    pub overflow_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceEntry {
    pub timestamp_ns: u64,
    pub from_pd: u8,
    pub to_pd: u8,
    pub channel: u8,
    pub opcode: u16,
    pub seq_lo: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TraceDumpResult {
    pub ok: u32,
    pub events_written: u32,
    pub bytes_written: u32,
    pub overflow_count: u32,
    pub events: Vec<TraceEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrafficEvent {
    pub seq: u64,
    pub at_ms: u64,
    pub opcode: u32,
    pub opcode_name: String,
    pub mr: [u32; 3],
    pub reply_mr: [u32; 4],
    pub shmem_in_len: u32,
    pub shmem_out_len: u32,
    pub ok: bool,
    pub error: Option<String>,
    pub duration_ms: u64,
}

// ── Connection bootstrap ──────────────────────────────────────────────────────

/// The unprompted 4112-byte greeting `cc_pd` sends the instant the socket
/// opens. `generation` is a 64-bit counter that increments every time the
/// transport resets — it is NOT stable across reconnects and must always be
/// echoed back from a freshly-read greeting, never hardcoded or cached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectionGreeting {
    pub magic: u32,
    pub version: u32,
    pub generation_lo: u32,
    pub generation_hi: u32,
}

// ── IPC client ────────────────────────────────────────────────────────────────

pub struct CcClient {
    stream: UnixStream,
    session_id: u32,
    traffic: VecDeque<TrafficEvent>,
    next_traffic_seq: u64,
}

impl CcClient {
    pub fn connect(sock_path: &str) -> io::Result<Self> {
        let mut stream = UnixStream::connect(sock_path)?;
        stream.set_read_timeout(Some(CC_IO_TIMEOUT))?;
        stream.set_write_timeout(Some(CC_IO_TIMEOUT))?;

        // Credential source is resolved before we touch the wire: a
        // malformed override must fail loudly, not silently fall back and
        // produce a confusing closed connection later.
        let credential = operator_credential()?;

        // 1. cc_pd speaks first: read its greeting before sending anything.
        let greeting = Self::read_greeting(&mut stream)?;

        // 2. Reply with CONNECTION_SYNC, echoing the version and generation
        //    cc_pd just sent (never hardcoded) and carrying the credential.
        Self::send_sync(&mut stream, &greeting, &credential)?;

        let mut client = CcClient {
            stream,
            session_id: 0,
            traffic: VecDeque::with_capacity(CC_TRAFFIC_MAX),
            next_traffic_seq: 0,
        };

        // 3. Only now is the connection active. MSG_CC_CONNECT establishes a
        //    session for the session-based opcodes this client uses
        //    (SEND/RECV/STATUS/...); sessionless opcodes (INSPECT,
        //    OPERATOR_*, AUTHORITY) would not need this step.
        let reply = client.send_recv(MSG_CC_CONNECT, 0xA6E70002, 0, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionRefused,
                format!("CC_CONNECT rejected: {ok}"),
            ));
        }
        client.session_id = u32::from_le_bytes(reply[4..8].try_into().unwrap());
        Ok(client)
    }

    /// Read the 4112-byte greeting `cc_pd` sends unprompted on connect.
    fn read_greeting(stream: &mut UnixStream) -> io::Result<ConnectionGreeting> {
        let mut buf = [0u8; CC_GREETING_SIZE];
        stream.read_exact(&mut buf).map_err(|err| {
            Self::bootstrap_io_error(err, "reading the cc_pd greeting")
        })?;
        let greeting = ConnectionGreeting {
            magic: u32::from_le_bytes(buf[0..4].try_into().unwrap()),
            version: u32::from_le_bytes(buf[4..8].try_into().unwrap()),
            generation_lo: u32::from_le_bytes(buf[8..12].try_into().unwrap()),
            generation_hi: u32::from_le_bytes(buf[12..16].try_into().unwrap()),
        };
        if greeting.magic != CC_CONNECTION_MAGIC {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "unexpected greeting magic {:#010x} (expected {:#010x}); \
                     this does not look like a cc_pd control socket",
                    greeting.magic, CC_CONNECTION_MAGIC
                ),
            ));
        }
        Ok(greeting)
    }

    /// Build the `MSG_CC_CONNECTION_SYNC` request frame: version and
    /// generation echoed verbatim from `greeting`, credential in
    /// `shmem[0..CC_OPERATOR_TOKEN_BYTES]`, every remaining shmem byte zero.
    fn build_sync_frame(
        greeting: &ConnectionGreeting,
        credential: &[u8; CC_OPERATOR_TOKEN_BYTES],
    ) -> [u8; CC_REQ_SIZE] {
        let mut req = [0u8; CC_REQ_SIZE];
        req[0..4].copy_from_slice(&MSG_CC_CONNECTION_SYNC.to_le_bytes());
        req[4..8].copy_from_slice(&greeting.version.to_le_bytes());
        req[8..12].copy_from_slice(&greeting.generation_lo.to_le_bytes());
        req[12..16].copy_from_slice(&greeting.generation_hi.to_le_bytes());
        req[16..16 + CC_OPERATOR_TOKEN_BYTES].copy_from_slice(credential);
        // req[16 + CC_OPERATOR_TOKEN_BYTES ..] stays zero-initialized (reserved).
        req
    }

    /// Send CONNECTION_SYNC and wait for CC_OK. A version, generation,
    /// credential, or reserved-byte mismatch makes cc_pd close the
    /// connection without replying — the read below will see EOF or time
    /// out, which `bootstrap_io_error` turns into an actionable message.
    fn send_sync(
        stream: &mut UnixStream,
        greeting: &ConnectionGreeting,
        credential: &[u8; CC_OPERATOR_TOKEN_BYTES],
    ) -> io::Result<()> {
        let req = Self::build_sync_frame(greeting, credential);
        stream
            .write_all(&req)
            .map_err(|err| Self::bootstrap_io_error(err, "sending CONNECTION_SYNC"))?;

        let mut reply = [0u8; CC_REPLY_SIZE];
        stream.read_exact(&mut reply).map_err(|err| {
            Self::bootstrap_io_error(err, "waiting for the CONNECTION_SYNC reply")
        })?;

        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        let version = u32::from_le_bytes(reply[4..8].try_into().unwrap());
        let gen_lo = u32::from_le_bytes(reply[8..12].try_into().unwrap());
        let gen_hi = u32::from_le_bytes(reply[12..16].try_into().unwrap());
        if ok != CC_OK
            || version != greeting.version
            || gen_lo != greeting.generation_lo
            || gen_hi != greeting.generation_hi
        {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionRefused,
                "cc_pd replied to CONNECTION_SYNC but did not confirm: \
                 credential rejected or protocol version mismatch.",
            ));
        }
        Ok(())
    }

    /// Map an I/O error seen during the bootstrap handshake to an
    /// actionable message. Per cc_contract.h, any mismatch in version,
    /// generation, credential, or reserved bytes makes cc_pd close the
    /// connection *without replying* — the client sees EOF or a read
    /// timeout, never a distinct error opcode. Surface that distinctly from
    /// an ordinary I/O failure so the user knows which knob to turn.
    fn bootstrap_io_error(err: io::Error, while_doing: &str) -> io::Error {
        match err.kind() {
            io::ErrorKind::UnexpectedEof
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::BrokenPipe => io::Error::new(
                err.kind(),
                format!(
                    "cc_pd closed the connection while {while_doing}: \
                     credential rejected or protocol version mismatch. \
                     Check AGENTOS_CC_OPERATOR_TOKEN_HEX and that this \
                     client's CC_CONNECTION_VERSION matches the running cc_pd."
                ),
            ),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => io::Error::new(
                err.kind(),
                format!(
                    "cc_pd did not respond while {while_doing} (timed out): \
                     credential rejected or protocol version mismatch. \
                     Check AGENTOS_CC_OPERATOR_TOKEN_HEX and that this \
                     client's CC_CONNECTION_VERSION matches the running cc_pd."
                ),
            ),
            _ => err,
        }
    }

    pub fn disconnect(&mut self) -> io::Result<()> {
        let _ = self.send_recv(MSG_CC_DISCONNECT, self.session_id, 0, 0, &[]);
        Ok(())
    }

    pub fn traffic_events(&self, limit: Option<usize>) -> Vec<TrafficEvent> {
        let limit = limit.unwrap_or(128).min(CC_TRAFFIC_MAX);
        let len = self.traffic.len();
        self.traffic
            .iter()
            .skip(len.saturating_sub(limit))
            .cloned()
            .collect()
    }

    pub fn list_sessions(&mut self) -> io::Result<Vec<SessionInfo>> {
        let reply = self.send_recv(MSG_CC_LIST, 8, 0, 0, &[])?;
        let count = u32::from_le_bytes(reply[0..4].try_into().unwrap()) as usize;
        let shmem = &reply[16..];
        const ENTRY: usize = 16; // cc_session_info_t: 4 x u32
        let mut out = Vec::with_capacity(count);
        for i in 0..count.min(shmem.len() / ENTRY) {
            let b = &shmem[i * ENTRY..];
            out.push(SessionInfo {
                session_id: u32::from_le_bytes(b[0..4].try_into().unwrap()),
                state: u32::from_le_bytes(b[4..8].try_into().unwrap()),
                client_badge: u32::from_le_bytes(b[8..12].try_into().unwrap()),
                ticks_since_active: u32::from_le_bytes(b[12..16].try_into().unwrap()),
            });
        }
        Ok(out)
    }

    pub fn session_status(&mut self, session_id: Option<u32>) -> io::Result<SessionStatus> {
        let sid = session_id.unwrap_or(self.session_id);
        let reply = self.send_recv(MSG_CC_STATUS, sid, 0, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("cc_status err {ok}"),
            ));
        }
        Ok(SessionStatus {
            session_id: sid,
            state: u32::from_le_bytes(reply[4..8].try_into().unwrap()),
            pending_responses: u32::from_le_bytes(reply[8..12].try_into().unwrap()),
            ticks_since_active: u32::from_le_bytes(reply[12..16].try_into().unwrap()),
        })
    }

    pub fn session_send(&mut self, cmd_type: u32, command: &str) -> io::Result<SessionSendResult> {
        let bytes = command.as_bytes();
        if bytes.len() > CC_SHMEM_SIZE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("command too large: {} bytes", bytes.len()),
            ));
        }
        let reply = self.send_recv(
            MSG_CC_SEND,
            self.session_id,
            cmd_type,
            bytes.len() as u32,
            bytes,
        )?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("cc_send err {ok}"),
            ));
        }
        Ok(SessionSendResult {
            ok,
            resp_pending: u32::from_le_bytes(reply[4..8].try_into().unwrap()),
        })
    }

    pub fn session_recv(&mut self, max: u32) -> io::Result<SessionRecvResult> {
        let max = max.min(CC_SHMEM_SIZE as u32);
        let reply = self.send_recv(MSG_CC_RECV, self.session_id, max, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("cc_recv err {ok}"),
            ));
        }
        let len = u32::from_le_bytes(reply[4..8].try_into().unwrap());
        let shmem = &reply[16..];
        let end = (len as usize).min(shmem.len());
        let bytes = &shmem[..end];
        Ok(SessionRecvResult {
            ok,
            len,
            text: String::from_utf8_lossy(bytes).into_owned(),
            hex: bytes
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<Vec<_>>()
                .join(" "),
        })
    }

    pub fn list_guests(&mut self) -> io::Result<Vec<GuestInfo>> {
        let reply = self.send_recv(MSG_CC_LIST_GUESTS, 16, 0, 0, &[])?;
        let count = u32::from_le_bytes(reply[0..4].try_into().unwrap()) as usize;
        let shmem = &reply[16..];
        const ENTRY: usize = 16; // cc_guest_info_t: 4 × u32
        let mut out = Vec::with_capacity(count);
        for i in 0..count.min(shmem.len() / ENTRY) {
            let b = &shmem[i * ENTRY..];
            let guest = GuestInfo {
                guest_handle: u32::from_le_bytes(b[0..4].try_into().unwrap()),
                state: u32::from_le_bytes(b[4..8].try_into().unwrap()),
                os_type: u32::from_le_bytes(b[8..12].try_into().unwrap()),
                arch: u32::from_le_bytes(b[12..16].try_into().unwrap()),
            };
            if guest.os_type == 0 || guest.arch == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "invalid guest entry {i} from cc_pd: handle={} state={} os_type={} arch={}",
                        guest.guest_handle, guest.state, guest.os_type, guest.arch
                    ),
                ));
            }
            out.push(guest);
        }
        Ok(out)
    }

    pub fn list_devices(&mut self, dev_type: u32) -> io::Result<Vec<DeviceInfo>> {
        let reply = self.send_recv(MSG_CC_LIST_DEVICES, dev_type, 32, 0, &[])?;
        let count = u32::from_le_bytes(reply[0..4].try_into().unwrap()) as usize;
        let shmem = &reply[16..];
        const ENTRY: usize = 16; // cc_device_info_t: 4 × u32
        let mut out = Vec::with_capacity(count);
        for i in 0..count.min(shmem.len() / ENTRY) {
            let b = &shmem[i * ENTRY..];
            out.push(DeviceInfo {
                dev_type: u32::from_le_bytes(b[0..4].try_into().unwrap()),
                dev_handle: u32::from_le_bytes(b[4..8].try_into().unwrap()),
                state: u32::from_le_bytes(b[8..12].try_into().unwrap()),
            });
        }
        Ok(out)
    }

    pub fn guest_status(&mut self, handle: u32) -> io::Result<GuestStatus> {
        let reply = self.send_recv(MSG_CC_GUEST_STATUS, handle, 0, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("guest_status err {ok}"),
            ));
        }
        let b = &reply[16..];
        Ok(GuestStatus {
            guest_handle: u32::from_le_bytes(b[0..4].try_into().unwrap()),
            state: u32::from_le_bytes(b[4..8].try_into().unwrap()),
            os_type: u32::from_le_bytes(b[8..12].try_into().unwrap()),
            arch: u32::from_le_bytes(b[12..16].try_into().unwrap()),
            device_flags: u32::from_le_bytes(b[16..20].try_into().unwrap()),
        })
    }

    pub fn list_polecats(&mut self) -> io::Result<PoecatStatus> {
        let reply = self.send_recv(MSG_CC_LIST_POLECATS, 0, 0, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Ok(PoecatStatus {
                total: 0,
                busy: 0,
                idle: 0,
            });
        }
        Ok(PoecatStatus {
            total: u32::from_le_bytes(reply[4..8].try_into().unwrap()),
            busy: u32::from_le_bytes(reply[8..12].try_into().unwrap()),
            idle: u32::from_le_bytes(reply[12..16].try_into().unwrap()),
        })
    }

    /// Read the boot-time authority snapshot: a ledger of what the root
    /// task recorded granting to each protection domain, by capability
    /// kind. Sessionless, like `MSG_CC_INSPECT`. See `authority_err` for
    /// how an unsupported opcode is distinguished from an envelope refusal.
    pub fn authority(&mut self) -> io::Result<AuthoritySnapshot> {
        // The full packed struct (header + all 32 rows) must fit in the
        // 4080-byte shmem region this reply carries; this is an ABI
        // invariant, not something that can vary at runtime.
        debug_assert!(AUTHORITY_SNAPSHOT_LEN <= CC_REPLY_SIZE - 16);
        let reply = self.send_recv(MSG_CC_AUTHORITY, AOS_AUTHORITY_VERSION, 0, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != CC_OK {
            return Err(authority_err(ok));
        }
        parse_authority_snapshot(&reply[16..])
    }

    pub fn snapshot(&mut self, handle: u32) -> io::Result<SnapResult> {
        let reply = self.send_recv(MSG_CC_SNAPSHOT, handle, 0, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(status_err("snapshot", ok));
        }
        Ok(SnapResult {
            snap_lo: u32::from_le_bytes(reply[4..8].try_into().unwrap()),
            snap_hi: u32::from_le_bytes(reply[8..12].try_into().unwrap()),
        })
    }

    pub fn restore(&mut self, handle: u32, snap_lo: u32, snap_hi: u32) -> io::Result<()> {
        let reply = self.send_recv(MSG_CC_RESTORE, handle, snap_lo, snap_hi, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(status_err("restore", ok));
        }
        Ok(())
    }

    pub fn suspend_guest(&mut self, handle: u32) -> io::Result<GuestLifecycleResult> {
        self.guest_lifecycle(MSG_CC_SUSPEND_GUEST, handle, 0)
    }

    pub fn resume_guest(&mut self, handle: u32) -> io::Result<GuestLifecycleResult> {
        self.guest_lifecycle(MSG_CC_RESUME_GUEST, handle, 0)
    }

    pub fn destroy_guest(&mut self, handle: u32, reason: u32) -> io::Result<GuestLifecycleResult> {
        self.guest_lifecycle(MSG_CC_DESTROY_GUEST, handle, reason)
    }

    fn guest_lifecycle(
        &mut self,
        opcode: u32,
        handle: u32,
        reason: u32,
    ) -> io::Result<GuestLifecycleResult> {
        let reply = self.send_recv(opcode, handle, reason, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("{} err {ok}", opcode_name(opcode).to_ascii_lowercase()),
            ));
        }
        let state = if opcode == MSG_CC_DESTROY_GUEST {
            6
        } else {
            u32::from_le_bytes(reply[4..8].try_into().unwrap())
        };
        Ok(GuestLifecycleResult { ok, state })
    }

    pub fn log_stream(&mut self, slot: u32, pd_id: u32) -> io::Result<String> {
        let reply = self.send_recv(MSG_CC_LOG_STREAM, slot, pd_id, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Ok(String::new());
        }
        let bytes = u32::from_le_bytes(reply[4..8].try_into().unwrap()) as usize;
        let shmem = &reply[16..];
        let end = bytes.min(shmem.len());
        let s = std::str::from_utf8(&shmem[..end])
            .unwrap_or("(invalid utf8)")
            .to_string();
        Ok(s)
    }

    pub fn device_status(
        &mut self,
        dev_type: u32,
        dev_handle: u32,
    ) -> io::Result<DeviceStatusInfo> {
        let reply = self.send_recv(MSG_CC_DEVICE_STATUS, dev_type, dev_handle, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("device_status err {ok}"),
            ));
        }
        let b = &reply[16..];
        Ok(DeviceStatusInfo {
            dev_type: u32::from_le_bytes(b[0..4].try_into().unwrap()),
            dev_handle: u32::from_le_bytes(b[4..8].try_into().unwrap()),
            state: u32::from_le_bytes(b[8..12].try_into().unwrap()),
        })
    }

    pub fn attach_framebuffer(&mut self, guest_handle: u32, fb_handle: u32) -> io::Result<u32> {
        let reply = self.send_recv(MSG_CC_ATTACH_FRAMEBUFFER, guest_handle, fb_handle, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("attach_framebuffer err {ok}"),
            ));
        }
        Ok(u32::from_le_bytes(reply[4..8].try_into().unwrap()))
    }

    pub fn send_input(&mut self, handle: u32, evt: &InputEvent) -> io::Result<()> {
        let mut shmem = [0u8; 24];
        shmem[0..4].copy_from_slice(&evt.event_type.to_le_bytes());
        shmem[4..8].copy_from_slice(&evt.keycode.to_le_bytes());
        shmem[8..12].copy_from_slice(&evt.dx.to_le_bytes());
        shmem[12..16].copy_from_slice(&evt.dy.to_le_bytes());
        shmem[16..20].copy_from_slice(&evt.btn_mask.to_le_bytes());
        let reply = self.send_recv(MSG_CC_SEND_INPUT, handle, 0, 0, &shmem)?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("send_input err {ok}"),
            ));
        }
        Ok(())
    }

    pub fn create_guest(&mut self, req: &GuestCreateRequest) -> io::Result<GuestCreateResult> {
        let mut shmem = [0u8; 52];
        shmem[0] = req.os_type as u8;
        shmem[1] = req.arch as u8;
        shmem[4..8].copy_from_slice(&req.ram_mb.to_le_bytes());
        shmem[8..12].copy_from_slice(&10_000u32.to_le_bytes());
        shmem[12..16].copy_from_slice(&10_000u32.to_le_bytes());
        shmem[16..20].copy_from_slice(&req.device_flags.to_le_bytes());

        let reply = self.send_recv(MSG_CC_CREATE_GUEST, 0, 0, 0, &shmem)?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                format!(
                    "create_guest err {ok}: current CC-PD did not complete the VibeOS create relay"
                ),
            ));
        }
        Ok(GuestCreateResult {
            handle: u32::from_le_bytes(reply[4..8].try_into().unwrap()),
        })
    }

    pub fn fault_inject(
        &mut self,
        slot_id: u32,
        fault_kind: u32,
        flags: u32,
    ) -> io::Result<FaultInjectResult> {
        let reply = self.send_recv(MSG_CC_FAULT_INJECT, slot_id, fault_kind, flags, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(status_err("fault_inject", ok));
        }
        Ok(FaultInjectResult {
            result: u32::from_le_bytes(reply[4..8].try_into().unwrap()),
            ticks_to_recovery: u32::from_le_bytes(reply[8..12].try_into().unwrap()),
            trace_event_id: u32::from_le_bytes(reply[12..16].try_into().unwrap()),
        })
    }

    pub fn trace_start(&mut self, flags: u32) -> io::Result<TraceStatus> {
        let reply = self.send_recv(MSG_CC_TRACE_START, flags, 0, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(status_err("trace_start", ok));
        }
        Ok(TraceStatus {
            ok,
            event_count: 0,
            bytes_used: 0,
            overflow_count: 0,
        })
    }

    pub fn trace_stop(&mut self) -> io::Result<TraceStatus> {
        let reply = self.send_recv(MSG_CC_TRACE_STOP, 0, 0, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(status_err("trace_stop", ok));
        }
        Ok(TraceStatus {
            ok,
            event_count: u32::from_le_bytes(reply[4..8].try_into().unwrap()),
            bytes_used: 0,
            overflow_count: 0,
        })
    }

    pub fn trace_query(&mut self) -> io::Result<TraceStatus> {
        let reply = self.send_recv(MSG_CC_TRACE_QUERY, 0, 0, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(status_err("trace_query", ok));
        }
        Ok(TraceStatus {
            ok,
            event_count: u32::from_le_bytes(reply[4..8].try_into().unwrap()),
            bytes_used: u32::from_le_bytes(reply[8..12].try_into().unwrap()),
            overflow_count: u32::from_le_bytes(reply[12..16].try_into().unwrap()),
        })
    }

    pub fn trace_dump(&mut self, max_events: u32) -> io::Result<TraceDumpResult> {
        let reply = self.send_recv(MSG_CC_TRACE_DUMP, max_events, 0, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(status_err("trace_dump", ok));
        }
        let events_written = u32::from_le_bytes(reply[4..8].try_into().unwrap());
        let bytes_written = u32::from_le_bytes(reply[8..12].try_into().unwrap());
        let overflow_count = u32::from_le_bytes(reply[12..16].try_into().unwrap());
        let shmem = &reply[16..];
        let count = (events_written as usize).min(shmem.len() / CC_TRACE_ENTRY_SIZE);
        let mut events = Vec::with_capacity(count);
        for i in 0..count {
            let b = &shmem[i * CC_TRACE_ENTRY_SIZE..(i + 1) * CC_TRACE_ENTRY_SIZE];
            events.push(TraceEntry {
                timestamp_ns: u64::from_le_bytes(b[0..8].try_into().unwrap()),
                from_pd: b[8],
                to_pd: b[9],
                channel: b[10],
                opcode: u16::from_le_bytes(b[12..14].try_into().unwrap()),
                seq_lo: u16::from_le_bytes(b[14..16].try_into().unwrap()),
            });
        }
        Ok(TraceDumpResult {
            ok,
            events_written,
            bytes_written,
            overflow_count,
            events,
        })
    }

    // ── Low-level send/recv ───────────────────────────────────────────────────

    fn send_recv(
        &mut self,
        opcode: u32,
        mr1: u32,
        mr2: u32,
        mr3: u32,
        shmem_in: &[u8],
    ) -> io::Result<[u8; CC_REPLY_SIZE]> {
        let started_at = Instant::now();
        let at_ms = now_ms();
        let req_mr = [mr1, mr2, mr3];

        let mut req = [0u8; CC_REQ_SIZE];
        req[0..4].copy_from_slice(&opcode.to_le_bytes());
        req[4..8].copy_from_slice(&mr1.to_le_bytes());
        req[8..12].copy_from_slice(&mr2.to_le_bytes());
        req[12..16].copy_from_slice(&mr3.to_le_bytes());
        let copy_len = shmem_in.len().min(CC_SHMEM_SIZE);
        if copy_len > 0 {
            req[16..16 + copy_len].copy_from_slice(&shmem_in[..copy_len]);
        }

        if let Err(err) = self.stream.write_all(&req).map_err(Self::cc_io_error) {
            let msg = err.to_string();
            self.record_traffic(
                opcode,
                req_mr,
                [0, 0, 0, 0],
                copy_len as u32,
                0,
                Some(msg),
                started_at,
                at_ms,
            );
            return Err(err);
        }

        let mut reply = [0u8; CC_REPLY_SIZE];
        if let Err(err) = self
            .stream
            .read_exact(&mut reply)
            .map_err(Self::cc_io_error)
        {
            let msg = err.to_string();
            self.record_traffic(
                opcode,
                req_mr,
                [0, 0, 0, 0],
                copy_len as u32,
                0,
                Some(msg),
                started_at,
                at_ms,
            );
            return Err(err);
        }

        let reply_mr = [
            u32::from_le_bytes(reply[0..4].try_into().unwrap()),
            u32::from_le_bytes(reply[4..8].try_into().unwrap()),
            u32::from_le_bytes(reply[8..12].try_into().unwrap()),
            u32::from_le_bytes(reply[12..16].try_into().unwrap()),
        ];
        self.record_traffic(
            opcode,
            req_mr,
            reply_mr,
            copy_len as u32,
            reply_shmem_len(opcode, reply_mr),
            None,
            started_at,
            at_ms,
        );
        Ok(reply)
    }

    fn record_traffic(
        &mut self,
        opcode: u32,
        mr: [u32; 3],
        reply_mr: [u32; 4],
        shmem_in_len: u32,
        shmem_out_len: u32,
        error: Option<String>,
        started_at: Instant,
        at_ms: u64,
    ) {
        if self.traffic.len() == CC_TRAFFIC_MAX {
            self.traffic.pop_front();
        }

        let has_ok_mr = opcode_has_ok_mr(opcode);
        let ok = error.is_none() && (!has_ok_mr || reply_mr[0] == 0);

        self.traffic.push_back(TrafficEvent {
            seq: self.next_traffic_seq,
            at_ms,
            opcode,
            opcode_name: opcode_name(opcode).into(),
            mr,
            reply_mr,
            shmem_in_len,
            shmem_out_len,
            ok,
            error,
            duration_ms: millis_since(started_at),
        });
        self.next_traffic_seq = self.next_traffic_seq.wrapping_add(1);
    }

    fn cc_io_error(err: io::Error) -> io::Error {
        match err.kind() {
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => io::Error::new(
                err.kind(),
                "CC-PD socket connected, but cc_pd did not reply within 5s. \
                 Verify agentOS booted cc_pd and close any other GUI/agentctl client.",
            ),
            _ => err,
        }
    }
}

// ── Operator credential ───────────────────────────────────────────────────────
//
// Source of truth: kernel/agentos-root-task/include/cc_operator_credential.h
// in the agentOS tree. Re-declared here by design (see README.md) — this
// repo does not build against that tree, so the value below is a literal
// copy, not an include.
//
// The credential is NOT a secret and must never be described as
// authentication: agentOS's threat model treats the local operator as
// untrusted and assumes they can read it. It only selects which authority
// envelope a connection receives.

/// Resolve the operator credential: `AGENTOS_CC_OPERATOR_TOKEN_HEX` (64 hex
/// characters) if set, else the well-known development token. A malformed
/// override fails loudly — it is never silently replaced by the development
/// token, because that would turn a typo into a confusing closed connection
/// instead of a clear configuration error.
fn operator_credential() -> io::Result<[u8; CC_OPERATOR_TOKEN_BYTES]> {
    match std::env::var("AGENTOS_CC_OPERATOR_TOKEN_HEX") {
        Ok(hex) => parse_credential_hex(&hex).map_err(|reason| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "AGENTOS_CC_OPERATOR_TOKEN_HEX is set but invalid ({reason}). \
                     Expected exactly {} hex characters (32 bytes). Refusing to \
                     silently fall back to the development token.",
                    CC_OPERATOR_TOKEN_BYTES * 2
                ),
            )
        }),
        Err(std::env::VarError::NotPresent) => Ok(dev_operator_credential()),
        Err(std::env::VarError::NotUnicode(_)) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "AGENTOS_CC_OPERATOR_TOKEN_HEX is set but is not valid UTF-8.",
        )),
    }
}

fn parse_credential_hex(hex: &str) -> Result<[u8; CC_OPERATOR_TOKEN_BYTES], String> {
    let hex = hex.trim();
    if hex.len() != CC_OPERATOR_TOKEN_BYTES * 2 {
        return Err(format!(
            "expected {} hex characters, got {}",
            CC_OPERATOR_TOKEN_BYTES * 2,
            hex.len()
        ));
    }
    let mut out = [0u8; CC_OPERATOR_TOKEN_BYTES];
    for (i, byte) in out.iter_mut().enumerate() {
        let chunk = hex.get(i * 2..i * 2 + 2).ok_or("truncated hex string")?;
        *byte = u8::from_str_radix(chunk, 16)
            .map_err(|_| format!("non-hex characters at position {}", i * 2))?;
    }
    Ok(out)
}

fn dev_operator_credential() -> [u8; CC_OPERATOR_TOKEN_BYTES] {
    parse_credential_hex(CC_DEV_OPERATOR_TOKEN_HEX)
        .expect("CC_DEV_OPERATOR_TOKEN_HEX constant must be valid hex")
}

fn opcode_name(opcode: u32) -> &'static str {
    match opcode {
        MSG_CC_CONNECT => "CONNECT",
        MSG_CC_DISCONNECT => "DISCONNECT",
        MSG_CC_SEND => "SEND",
        MSG_CC_RECV => "RECV",
        MSG_CC_STATUS => "STATUS",
        MSG_CC_LIST => "LIST",
        MSG_CC_LIST_GUESTS => "LIST_GUESTS",
        MSG_CC_LIST_DEVICES => "LIST_DEVICES",
        MSG_CC_LIST_POLECATS => "LIST_POLECATS",
        MSG_CC_GUEST_STATUS => "GUEST_STATUS",
        MSG_CC_DEVICE_STATUS => "DEVICE_STATUS",
        MSG_CC_ATTACH_FRAMEBUFFER => "ATTACH_FRAMEBUFFER",
        MSG_CC_SEND_INPUT => "SEND_INPUT",
        MSG_CC_SNAPSHOT => "SNAPSHOT",
        MSG_CC_RESTORE => "RESTORE",
        MSG_CC_LOG_STREAM => "LOG_STREAM",
        MSG_CC_CREATE_GUEST => "CREATE_GUEST",
        MSG_CC_FAULT_INJECT => "FAULT_INJECT",
        MSG_CC_SUSPEND_GUEST => "SUSPEND_GUEST",
        MSG_CC_RESUME_GUEST => "RESUME_GUEST",
        MSG_CC_DESTROY_GUEST => "DESTROY_GUEST",
        MSG_CC_TRACE_START => "TRACE_START",
        MSG_CC_TRACE_STOP => "TRACE_STOP",
        MSG_CC_TRACE_QUERY => "TRACE_QUERY",
        MSG_CC_TRACE_DUMP => "TRACE_DUMP",
        MSG_CC_AUTHORITY => "AUTHORITY",
        _ => "UNKNOWN",
    }
}

fn opcode_has_ok_mr(opcode: u32) -> bool {
    matches!(
        opcode,
        MSG_CC_CONNECT
            | MSG_CC_DISCONNECT
            | MSG_CC_SEND
            | MSG_CC_RECV
            | MSG_CC_STATUS
            | MSG_CC_LIST_POLECATS
            | MSG_CC_GUEST_STATUS
            | MSG_CC_DEVICE_STATUS
            | MSG_CC_ATTACH_FRAMEBUFFER
            | MSG_CC_SEND_INPUT
            | MSG_CC_SNAPSHOT
            | MSG_CC_RESTORE
            | MSG_CC_LOG_STREAM
            | MSG_CC_CREATE_GUEST
            | MSG_CC_FAULT_INJECT
            | MSG_CC_SUSPEND_GUEST
            | MSG_CC_RESUME_GUEST
            | MSG_CC_DESTROY_GUEST
            | MSG_CC_TRACE_START
            | MSG_CC_TRACE_STOP
            | MSG_CC_TRACE_QUERY
            | MSG_CC_TRACE_DUMP
            | MSG_CC_AUTHORITY
    )
}

fn reply_shmem_len(opcode: u32, mr: [u32; 4]) -> u32 {
    match opcode {
        MSG_CC_RECV | MSG_CC_LOG_STREAM => mr[1].min(CC_SHMEM_SIZE as u32),
        MSG_CC_LIST => mr[0].saturating_mul(16).min(CC_SHMEM_SIZE as u32),
        MSG_CC_LIST_GUESTS => mr[0].saturating_mul(16).min(CC_SHMEM_SIZE as u32),
        MSG_CC_LIST_DEVICES => mr[0].saturating_mul(16).min(CC_SHMEM_SIZE as u32),
        MSG_CC_GUEST_STATUS if mr[0] == 0 => 32,
        MSG_CC_DEVICE_STATUS if mr[0] == 0 => 16,
        MSG_CC_TRACE_DUMP if mr[0] == 0 => mr[2].min(CC_SHMEM_SIZE as u32),
        MSG_CC_AUTHORITY if mr[0] == 0 => mr[1].min(CC_SHMEM_SIZE as u32),
        _ => 0,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn millis_since(start: Instant) -> u64 {
    start.elapsed().as_millis().min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Step 1 of task-1-brief.md: build a sync frame from a synthetic
    /// greeting and assert opcode, echoed version/generation, credential
    /// placement, and zeroed reserved bytes. The generation here (an
    /// arbitrary, non-hardcoded-looking pair) stands in for "whatever cc_pd
    /// happened to send" — the whole point is that CcClient must echo it,
    /// not assume any particular value.
    #[test]
    fn sync_frame_echoes_greeting_and_carries_credential() {
        let greeting = ConnectionGreeting {
            magic: CC_CONNECTION_MAGIC,
            version: 7,
            generation_lo: 0xDEAD_BEEF,
            generation_hi: 0x1357_9BDF,
        };
        let credential = [0xABu8; CC_OPERATOR_TOKEN_BYTES];

        let frame = CcClient::build_sync_frame(&greeting, &credential);

        assert_eq!(frame.len(), CC_REQ_SIZE);

        let opcode = u32::from_le_bytes(frame[0..4].try_into().unwrap());
        assert_eq!(opcode, MSG_CC_CONNECTION_SYNC);
        assert_eq!(opcode, 0x261F);

        let version = u32::from_le_bytes(frame[4..8].try_into().unwrap());
        assert_eq!(version, greeting.version, "must echo the greeting's version");

        let gen_lo = u32::from_le_bytes(frame[8..12].try_into().unwrap());
        let gen_hi = u32::from_le_bytes(frame[12..16].try_into().unwrap());
        assert_eq!(
            gen_lo, greeting.generation_lo,
            "must echo the greeting's generation low word, never hardcode it"
        );
        assert_eq!(
            gen_hi, greeting.generation_hi,
            "must echo the greeting's generation high word, never hardcode it"
        );

        assert_eq!(
            &frame[16..16 + CC_OPERATOR_TOKEN_BYTES],
            &credential[..],
            "credential must occupy shmem[0..32]"
        );
        assert!(
            frame[16 + CC_OPERATOR_TOKEN_BYTES..]
                .iter()
                .all(|&b| b == 0),
            "every reserved shmem byte beyond the credential must be zero"
        );
    }

    /// A different synthetic generation must produce a different frame —
    /// guards against a hardcoded generation that "happens" to match a
    /// freshly-booted PD and only breaks after a reconnect.
    #[test]
    fn sync_frame_tracks_generation_changes_across_reconnects() {
        let credential = [0x11u8; CC_OPERATOR_TOKEN_BYTES];

        let first = ConnectionGreeting {
            magic: CC_CONNECTION_MAGIC,
            version: CC_CONNECTION_VERSION,
            generation_lo: 1,
            generation_hi: 0,
        };
        let second = ConnectionGreeting {
            magic: CC_CONNECTION_MAGIC,
            version: CC_CONNECTION_VERSION,
            generation_lo: 2,
            generation_hi: 0,
        };

        let frame_first = CcClient::build_sync_frame(&first, &credential);
        let frame_second = CcClient::build_sync_frame(&second, &credential);

        assert_ne!(
            &frame_first[8..16],
            &frame_second[8..16],
            "generation words must track the greeting, not a cached/hardcoded value"
        );
    }

    #[test]
    fn dev_credential_is_well_formed() {
        let cred = dev_operator_credential();
        assert_eq!(cred.len(), CC_OPERATOR_TOKEN_BYTES);
    }

    #[test]
    fn credential_hex_round_trips() {
        let hex = "11".repeat(CC_OPERATOR_TOKEN_BYTES);
        let cred = parse_credential_hex(&hex).expect("valid hex must parse");
        assert_eq!(cred, [0x11u8; CC_OPERATOR_TOKEN_BYTES]);
    }

    #[test]
    fn malformed_credential_hex_is_rejected_not_silently_defaulted() {
        assert!(parse_credential_hex("not-hex-at-all-not-hex-at-all-not-hex-at-all-xx").is_err());
        assert!(parse_credential_hex("ab").is_err(), "too short must fail");
        assert!(
            parse_credential_hex(&"11".repeat(CC_OPERATOR_TOKEN_BYTES + 1)).is_err(),
            "too long must fail"
        );
    }

    // ── Authority snapshot parsing (task-3-brief.md) ─────────────────────────
    //
    // There is no live cc_pd in this environment, so these tests build a
    // synthetic `aos_authority_snapshot_t` byte buffer by hand, matching the
    // packed C layout exactly (platform/include/platform/authority.h), and
    // assert the parser decodes it correctly. This is the achievable proof
    // of the parser's correctness; it is not evidence of a real connection.

    /// Write one 60-byte packed row (pd_index, 32-byte name, 11 counts,
    /// reserved) into `buf` at `offset`.
    fn write_authority_row(
        buf: &mut [u8],
        offset: usize,
        pd_index: u32,
        name: &[u8],
        counts: &[u16; AOS_AUTHORITY_KIND_COUNT],
    ) {
        buf[offset..offset + 4].copy_from_slice(&pd_index.to_le_bytes());
        let name_field = &mut buf[offset + 4..offset + 4 + AOS_AUTHORITY_NAME_LEN];
        name_field.fill(0);
        let n = name.len().min(AOS_AUTHORITY_NAME_LEN);
        name_field[..n].copy_from_slice(&name[..n]);
        let counts_off = offset + 4 + AOS_AUTHORITY_NAME_LEN;
        for (k, c) in counts.iter().enumerate() {
            buf[counts_off + k * 2..counts_off + k * 2 + 2].copy_from_slice(&c.to_le_bytes());
        }
        // reserved u16 at counts_off + 22..+24 stays zero.
    }

    fn synthetic_snapshot_buf(pd_count: u32) -> Vec<u8> {
        let mut buf = vec![0u8; AUTHORITY_SNAPSHOT_LEN];
        buf[0..4].copy_from_slice(&AOS_AUTHORITY_VERSION.to_le_bytes());
        buf[4..8].copy_from_slice(&pd_count.to_le_bytes());
        buf[8..12].copy_from_slice(&7u32.to_le_bytes()); // total_recorded
        buf[12..16].copy_from_slice(&0u32.to_le_bytes()); // truncated_adds
        buf[16..20].copy_from_slice(&0u32.to_le_bytes()); // saturated
        buf
    }

    #[test]
    fn parses_root_sentinel_and_a_named_domain() {
        let mut buf = synthetic_snapshot_buf(2);

        let mut root_counts = [0u16; AOS_AUTHORITY_KIND_COUNT];
        root_counts[0] = 3; // untyped

        let mut pd_counts = [0u16; AOS_AUTHORITY_KIND_COUNT];
        pd_counts[1] = 4; // tcb
        pd_counts[2] = 1; // endpoint

        write_authority_row(
            &mut buf,
            AUTHORITY_HEADER_LEN,
            AOS_AUTHORITY_ROOT_PD_INDEX,
            b"root-cnode",
            &root_counts,
        );
        write_authority_row(
            &mut buf,
            AUTHORITY_HEADER_LEN + AUTHORITY_ROW_LEN,
            0,
            b"nameserver",
            &pd_counts,
        );

        let snap = parse_authority_snapshot(&buf).expect("synthetic snapshot must parse");
        assert_eq!(snap.version, AOS_AUTHORITY_VERSION);
        assert_eq!(snap.pd_count, 2);
        assert_eq!(snap.total_recorded, 7);
        assert!(!snap.saturated);
        assert_eq!(snap.rows.len(), 2);

        assert_eq!(snap.rows[0].pd_index, AOS_AUTHORITY_ROOT_PD_INDEX);
        assert!(snap.rows[0].is_root, "0xFFFFFFFF must be rendered as the root task");
        assert_eq!(snap.rows[0].name, "root-cnode");
        assert_eq!(snap.rows[0].counts[0], 3);

        assert_eq!(snap.rows[1].pd_index, 0);
        assert!(!snap.rows[1].is_root, "descriptor index 0 (nameserver) is not root");
        assert_eq!(snap.rows[1].name, "nameserver");
        assert_eq!(snap.rows[1].counts[1], 4);
        assert_eq!(snap.rows[1].counts[2], 1);
    }

    #[test]
    fn name_truncates_at_the_recorded_nul_without_assuming_a_c_string() {
        // "operator_session" is 17 bytes; the upstream 16-byte source field
        // (cap_accounting.h's cap_acct_entry_t.name) truncates it to
        // "operator_sessio" (15 chars) before it ever reaches the 32-byte
        // authority row. The parser must render exactly what arrived, not
        // guess at or "fix" a longer name.
        let mut buf = synthetic_snapshot_buf(1);
        write_authority_row(
            &mut buf,
            AUTHORITY_HEADER_LEN,
            7,
            b"operator_sessio",
            &[0u16; AOS_AUTHORITY_KIND_COUNT],
        );

        let snap = parse_authority_snapshot(&buf).unwrap();
        assert_eq!(snap.rows[0].name, "operator_sessio");
    }

    #[test]
    fn rejects_an_unknown_version_before_indexing_anything() {
        let mut buf = synthetic_snapshot_buf(1);
        buf[0..4].copy_from_slice(&999u32.to_le_bytes());
        let err = parse_authority_snapshot(&buf).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("version"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_pd_count_above_the_abi_maximum_before_indexing_anything() {
        let mut buf = synthetic_snapshot_buf(0);
        buf[4..8].copy_from_slice(&(AOS_AUTHORITY_MAX_PDS as u32 + 1).to_le_bytes());
        let err = parse_authority_snapshot(&buf).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("pd_count"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_a_buffer_truncated_before_its_declared_rows() {
        let buf = synthetic_snapshot_buf(2);
        let truncated = &buf[..AUTHORITY_HEADER_LEN + AUTHORITY_ROW_LEN]; // only 1 of 2 rows
        let err = parse_authority_snapshot(truncated).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn an_unrecognized_opcode_status_is_reported_as_unsupported_not_not_permitted() {
        // CC_ERR_BAD_SESSION (2) on this sessionless call means the
        // connected cc_pd's dispatcher fell through to its `default:` case
        // -- i.e. it does not know MSG_CC_AUTHORITY at all (an older
        // cc_pd). This must be distinguishable from CC_ERR_NOT_PERMITTED
        // (11), an authority-envelope refusal, and from a transport error.
        let unsupported = authority_err(CC_ERR_BAD_SESSION);
        assert_eq!(unsupported.kind(), io::ErrorKind::Unsupported);

        let refused = authority_err(CC_ERR_NOT_PERMITTED);
        assert_eq!(refused.kind(), io::ErrorKind::PermissionDenied);

        let other = authority_err(9); // CC_ERR_INVALID_ARG
        assert_eq!(other.kind(), io::ErrorKind::Other);
    }

    // ── Drift guard against the agentOS source tree ─────────────────────
    //
    // Everything above this point in this file re-declares protocol
    // constants owned by agentOS, by design (see README.md "Zero kernel
    // headers included"). That separation is deliberate, but until now
    // nothing checked it -- which is how a mandatory first frame
    // (MSG_CC_CONNECTION_SYNC, landed in cc_pd 2026-09-21) and a wrong
    // authority-row layout (name[48]/80 bytes specified vs. the real
    // name[32]/60 bytes) both slipped past unnoticed. This test parses the
    // authoritative #define/enum values straight out of the agentOS source
    // tree, if it can find one, and fails loudly if this repo's copies
    // have drifted from them.
    //
    // *** THIS TEST SKIPS, RATHER THAN FAILS OR PASSES MEANINGFULLY, WHEN
    // IT CANNOT FIND AN agentOS TREE. *** `cargo test` will still print
    // "test cc_ipc::tests::drift_guard_against_agentos_source ... ok" in
    // that case -- that is Rust's test harness reporting "did not panic,"
    // not this test claiming to have verified anything. To tell a skip
    // from a real pass, run `cargo test -- --nocapture` (output is
    // captured and hidden by default on a passing test) and look for one
    // of these two banners:
    //   "DRIFT GUARD: comparing against agentOS source at ..."     (ran)
    //   "DRIFT GUARD SKIPPED: agentOS source tree not found ..."   (skipped)
    // See README.md, "Keeping the re-declared constants honest," for more.

    /// Locate the agentOS source tree: the `AGENTOS_SRC` env var if set,
    /// else the sibling `../agentos` checkout (relative to this repo's
    /// root, i.e. `CARGO_MANIFEST_DIR/../../agentos` from `src-tauri`).
    /// Returns `None` -- never panics, never falls back silently -- if
    /// neither resolves to a real checkout, so the caller can skip loudly
    /// instead of erroring out on a contributor who simply doesn't have
    /// the other repo cloned.
    fn find_agentos_src() -> Option<std::path::PathBuf> {
        let candidate = if let Ok(p) = std::env::var("AGENTOS_SRC") {
            std::path::PathBuf::from(p)
        } else {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../agentos")
        };
        let marker = candidate.join("kernel/agentos-root-task/include/agentos.h");
        if marker.is_file() {
            Some(candidate)
        } else {
            None
        }
    }

    /// Parse the integer value out of a simple `#define NAME value` macro
    /// -- the style used throughout agentOS's headers: optional `0x...`
    /// hex or decimal, optional trailing `u`/`U`/`l`/`L` suffix, rest of
    /// the line (comments, etc.) ignored.
    fn parse_c_define(src: &str, name: &str) -> Option<i64> {
        for line in src.lines() {
            let line = line.trim_start();
            if !line.starts_with("#define") {
                continue;
            }
            let rest = line["#define".len()..].trim_start();
            let mut parts = rest.splitn(2, char::is_whitespace);
            if parts.next()? != name {
                continue;
            }
            let value_part = parts.next()?.trim_start();
            let token = value_part.split_whitespace().next()?;
            let token = token.trim_end_matches(['u', 'U', 'l', 'L']);
            return parse_int_token(token);
        }
        None
    }

    /// Parse `NAME = <value>,` out of a C enum body (used for `CC_OK` and
    /// `CC_ERR_NOT_PERMITTED`, which are `enum cc_error` members, not
    /// `#define`s, in cc_contract.h).
    fn parse_enum_value(src: &str, name: &str) -> Option<i64> {
        for line in src.lines() {
            let line = line.trim();
            if !line.starts_with(name) {
                continue;
            }
            let after_name = line[name.len()..].trim_start();
            if !after_name.starts_with('=') {
                continue;
            }
            let value_part = after_name[1..].trim_start();
            let token = value_part.split(|c: char| c == ',' || c.is_whitespace()).next()?;
            return parse_int_token(token);
        }
        None
    }

    fn parse_int_token(token: &str) -> Option<i64> {
        if let Some(hex) = token.strip_prefix("0x").or_else(|| token.strip_prefix("0X")) {
            i64::from_str_radix(hex, 16).ok()
        } else {
            token.parse::<i64>().ok()
        }
    }

    #[test]
    fn drift_guard_against_agentos_source() {
        let Some(root) = find_agentos_src() else {
            eprintln!(
                "\n*** DRIFT GUARD SKIPPED: agentOS source tree not found. ***\n\
                 Checked $AGENTOS_SRC and the sibling '../agentos' checkout. This test \
                 did NOT verify this repo's re-declared constants against anything this \
                 run -- it is a skip, not a pass. Clone agentOS as a sibling of this \
                 repo, or set AGENTOS_SRC=/path/to/agentos, to exercise it. See \
                 README.md, 'Keeping the re-declared constants honest'.\n"
            );
            return;
        };
        eprintln!("\n*** DRIFT GUARD: comparing against agentOS source at {} ***\n", root.display());

        let agentos_h = std::fs::read_to_string(root.join("kernel/agentos-root-task/include/agentos.h"))
            .expect("agentos.h should be readable: its presence was just checked");
        let cc_contract_h = std::fs::read_to_string(
            root.join("kernel/agentos-root-task/include/contracts/cc_contract.h"),
        )
        .expect("cc_contract.h should be present in an agentOS checkout");
        let operator_credential_h = std::fs::read_to_string(
            root.join("kernel/agentos-root-task/include/cc_operator_credential.h"),
        )
        .expect("cc_operator_credential.h should be present in an agentOS checkout");
        let authority_h = std::fs::read_to_string(root.join("platform/include/platform/authority.h"))
            .expect("platform/include/platform/authority.h should be present in an agentOS checkout");

        // ── MSG_CC_* opcodes ──────────────────────────────────────────────
        let opcodes: &[(&str, u32)] = &[
            ("MSG_CC_CONNECT", MSG_CC_CONNECT),
            ("MSG_CC_DISCONNECT", MSG_CC_DISCONNECT),
            ("MSG_CC_SEND", MSG_CC_SEND),
            ("MSG_CC_RECV", MSG_CC_RECV),
            ("MSG_CC_STATUS", MSG_CC_STATUS),
            ("MSG_CC_LIST", MSG_CC_LIST),
            ("MSG_CC_LIST_GUESTS", MSG_CC_LIST_GUESTS),
            ("MSG_CC_LIST_DEVICES", MSG_CC_LIST_DEVICES),
            ("MSG_CC_LIST_POLECATS", MSG_CC_LIST_POLECATS),
            ("MSG_CC_GUEST_STATUS", MSG_CC_GUEST_STATUS),
            ("MSG_CC_DEVICE_STATUS", MSG_CC_DEVICE_STATUS),
            ("MSG_CC_ATTACH_FRAMEBUFFER", MSG_CC_ATTACH_FRAMEBUFFER),
            ("MSG_CC_SEND_INPUT", MSG_CC_SEND_INPUT),
            ("MSG_CC_SNAPSHOT", MSG_CC_SNAPSHOT),
            ("MSG_CC_RESTORE", MSG_CC_RESTORE),
            ("MSG_CC_LOG_STREAM", MSG_CC_LOG_STREAM),
            ("MSG_CC_CREATE_GUEST", MSG_CC_CREATE_GUEST),
            ("MSG_CC_FAULT_INJECT", MSG_CC_FAULT_INJECT),
            ("MSG_CC_SUSPEND_GUEST", MSG_CC_SUSPEND_GUEST),
            ("MSG_CC_RESUME_GUEST", MSG_CC_RESUME_GUEST),
            ("MSG_CC_DESTROY_GUEST", MSG_CC_DESTROY_GUEST),
            ("MSG_CC_TRACE_START", MSG_CC_TRACE_START),
            ("MSG_CC_TRACE_STOP", MSG_CC_TRACE_STOP),
            ("MSG_CC_TRACE_QUERY", MSG_CC_TRACE_QUERY),
            ("MSG_CC_TRACE_DUMP", MSG_CC_TRACE_DUMP),
            ("MSG_CC_CONNECTION_SYNC", MSG_CC_CONNECTION_SYNC),
            ("MSG_CC_AUTHORITY", MSG_CC_AUTHORITY),
        ];
        for (name, ours) in opcodes {
            let theirs = parse_c_define(&agentos_h, name)
                .unwrap_or_else(|| panic!("DRIFT GUARD: {name} not found in agentos.h -- renamed or removed?"));
            assert_eq!(
                *ours as i64, theirs,
                "DRIFT GUARD: {name} = {:#x} in this repo but {:#x} in agentos.h -- re-declared opcode has drifted",
                ours, theirs
            );
        }

        // ── Handshake constants ───────────────────────────────────────────
        let their_magic = parse_c_define(&cc_contract_h, "CC_CONNECTION_MAGIC")
            .expect("DRIFT GUARD: CC_CONNECTION_MAGIC not found in cc_contract.h");
        assert_eq!(CC_CONNECTION_MAGIC as i64, their_magic, "DRIFT GUARD: CC_CONNECTION_MAGIC drifted");

        let their_version = parse_c_define(&cc_contract_h, "CC_CONNECTION_VERSION")
            .expect("DRIFT GUARD: CC_CONNECTION_VERSION not found in cc_contract.h");
        assert_eq!(CC_CONNECTION_VERSION as i64, their_version, "DRIFT GUARD: CC_CONNECTION_VERSION drifted");

        let their_ok = parse_enum_value(&cc_contract_h, "CC_OK")
            .expect("DRIFT GUARD: CC_OK not found in cc_contract.h's enum cc_error");
        assert_eq!(CC_OK as i64, their_ok, "DRIFT GUARD: CC_OK drifted");

        let their_not_permitted = parse_enum_value(&cc_contract_h, "CC_ERR_NOT_PERMITTED")
            .expect("DRIFT GUARD: CC_ERR_NOT_PERMITTED not found in cc_contract.h's enum cc_error");
        assert_eq!(
            CC_ERR_NOT_PERMITTED as i64, their_not_permitted,
            "DRIFT GUARD: CC_ERR_NOT_PERMITTED drifted"
        );

        // ── Wire frame sizes ────────────────────────────────────────────
        // CC_MAX_CMD_BYTES / CC_MAX_RESP_BYTES are agentOS's names for the
        // shmem region this repo calls CC_SHMEM_SIZE; request/reply frame
        // sizes aren't separately named constants in the C header (the doc
        // comment just says "4112-byte"), so we reconstruct and compare
        // them from the shmem size plus the fixed opcode/mr header widths.
        let their_max_cmd = parse_c_define(&cc_contract_h, "CC_MAX_CMD_BYTES")
            .expect("DRIFT GUARD: CC_MAX_CMD_BYTES not found in cc_contract.h");
        let their_max_resp = parse_c_define(&cc_contract_h, "CC_MAX_RESP_BYTES")
            .expect("DRIFT GUARD: CC_MAX_RESP_BYTES not found in cc_contract.h");
        assert_eq!(
            their_max_cmd, their_max_resp,
            "DRIFT GUARD: agentOS's own CC_MAX_CMD_BYTES and CC_MAX_RESP_BYTES diverged; \
             this repo assumes one shmem size for both directions"
        );
        assert_eq!(
            CC_SHMEM_SIZE as i64, their_max_cmd,
            "DRIFT GUARD: CC_SHMEM_SIZE drifted from agentOS's CC_MAX_CMD_BYTES/CC_MAX_RESP_BYTES"
        );
        assert_eq!(
            CC_REQ_SIZE as i64,
            4 + 12 + their_max_cmd,
            "DRIFT GUARD: request frame size (opcode(4) + mr[3](12) + shmem) drifted"
        );
        assert_eq!(
            CC_REPLY_SIZE as i64,
            16 + their_max_resp,
            "DRIFT GUARD: reply frame size (mr[4](16) + shmem) drifted"
        );
        assert_eq!(
            CC_GREETING_SIZE, CC_REPLY_SIZE,
            "DRIFT GUARD: greeting frame no longer matches the reply wire shape"
        );

        // ── Operator credential ───────────────────────────────────────────
        let their_token_bytes = parse_c_define(&operator_credential_h, "CC_OPERATOR_TOKEN_BYTES")
            .expect("DRIFT GUARD: CC_OPERATOR_TOKEN_BYTES not found in cc_operator_credential.h");
        assert_eq!(
            CC_OPERATOR_TOKEN_BYTES as i64, their_token_bytes,
            "DRIFT GUARD: CC_OPERATOR_TOKEN_BYTES drifted"
        );

        // ── Authority snapshot layout ───────────────────────────────────
        // This is the one that just bit: a prior brief specified
        // name[48]/80-byte rows, and the real struct is name[32]/60-byte
        // rows. A struct-size check here would have caught it instantly.
        let their_name_len = parse_c_define(&authority_h, "AOS_AUTHORITY_NAME_LEN")
            .expect("DRIFT GUARD: AOS_AUTHORITY_NAME_LEN not found in authority.h");
        assert_eq!(
            AOS_AUTHORITY_NAME_LEN as i64, their_name_len,
            "DRIFT GUARD: AOS_AUTHORITY_NAME_LEN drifted -- row parsing would read wrong offsets"
        );

        let their_kind_count = parse_c_define(&authority_h, "AOS_AUTHORITY_KIND_COUNT")
            .expect("DRIFT GUARD: AOS_AUTHORITY_KIND_COUNT not found in authority.h");
        assert_eq!(
            AOS_AUTHORITY_KIND_COUNT as i64, their_kind_count,
            "DRIFT GUARD: AOS_AUTHORITY_KIND_COUNT drifted -- counts[] array length mismatch"
        );

        let their_max_pds = parse_c_define(&authority_h, "AOS_AUTHORITY_MAX_PDS")
            .expect("DRIFT GUARD: AOS_AUTHORITY_MAX_PDS not found in authority.h");
        assert_eq!(
            AOS_AUTHORITY_MAX_PDS as i64, their_max_pds,
            "DRIFT GUARD: AOS_AUTHORITY_MAX_PDS drifted -- snapshot size mismatch"
        );

        let their_authority_version = parse_c_define(&authority_h, "AOS_AUTHORITY_VERSION")
            .expect("DRIFT GUARD: AOS_AUTHORITY_VERSION not found in authority.h");
        assert_eq!(
            AOS_AUTHORITY_VERSION as i64, their_authority_version,
            "DRIFT GUARD: AOS_AUTHORITY_VERSION drifted"
        );

        // Row stride, computed from the *real* field widths read above --
        // not hardcoded -- which is exactly the check that would have
        // caught the name[48]/80-byte spec error before any parsing code
        // was built against it.
        let their_row_len = 4 + their_name_len + their_kind_count * 2 + 2;
        assert_eq!(
            AUTHORITY_ROW_LEN as i64, their_row_len,
            "DRIFT GUARD: authority row stride drifted ({} bytes here vs {} computed from \
             agentOS's own field widths) -- a parser built to the old stride reads counts \
             and names at the wrong offsets and renders plausible garbage instead of crashing",
            AUTHORITY_ROW_LEN, their_row_len
        );

        eprintln!(
            "*** DRIFT GUARD: {} MSG_CC_* opcodes + handshake + authority layout constants verified against {} ***\n",
            opcodes.len(),
            root.display()
        );
    }

}
