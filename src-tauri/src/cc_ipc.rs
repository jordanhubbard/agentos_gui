//! agentOS CC-PD IPC client
//!
//! Wire protocol (from agentctl_ng.c / cc_contract.h):
//!   Request:  opcode(4) + mr[3](12) + shmem(4096) = 4112 bytes
//!   Reply:    mr[4](16) + shmem(4096) = 4112 bytes
//!
//! Transport: Unix domain socket at CC_PD_SOCK (default: build/cc_pd.sock)
//! All MSG_CC_* constants mirror agentos.h exactly.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

mod desktop_input;
pub use desktop_input::{DesktopInputEvent, InputBatchAck};
mod frame_capture;
pub use frame_capture::FrameInfo;

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
pub const MSG_CC_INPUT_SUBMIT: u32 = 0x261E;
pub const MSG_CC_FRAME_CAPTURE: u32 = 0x261D;

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
const CC_IO_TIMEOUT: Duration = Duration::from_secs(5);
const CC_TRAFFIC_MAX: usize = 512;
const CC_TRACE_ENTRY_SIZE: usize = 16;

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

// ── IPC client ────────────────────────────────────────────────────────────────

pub struct CcClient {
    stream: UnixStream,
    session_id: u32,
    traffic: VecDeque<TrafficEvent>,
    next_traffic_seq: u64,
    frame: Option<frame_capture::Snapshot>,
}

impl CcClient {
    pub fn connect(sock_path: &str) -> io::Result<Self> {
        let stream = UnixStream::connect(sock_path)?;
        stream.set_read_timeout(Some(CC_IO_TIMEOUT))?;
        stream.set_write_timeout(Some(CC_IO_TIMEOUT))?;
        let mut client = CcClient {
            stream,
            session_id: 0,
            traffic: VecDeque::with_capacity(CC_TRAFFIC_MAX),
            next_traffic_seq: 0,
            frame: None,
        };

        // MSG_CC_CONNECT — establish session
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

    pub fn snapshot(&mut self, handle: u32) -> io::Result<SnapResult> {
        let reply = self.send_recv(MSG_CC_SNAPSHOT, handle, 0, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("snapshot err {ok}"),
            ));
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
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("restore err {ok}"),
            ));
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

    /// Explicit public-handle addressing; mode zero is the legacy log-slot API.
    pub fn guest_console(&mut self, handle: u32) -> io::Result<String> {
        const CC_LOG_ADDRESS_HANDLE: u32 = 1;
        let reply = self.send_recv(MSG_CC_LOG_STREAM, handle, 0, CC_LOG_ADDRESS_HANDLE, &[])?;
        let status = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        let length = u32::from_le_bytes(reply[4..8].try_into().unwrap()) as usize;
        let echoed = u32::from_le_bytes(reply[8..12].try_into().unwrap());
        if status != 0 || length > CC_SHMEM_SIZE || echoed != handle {
            return Err(io::Error::new(io::ErrorKind::InvalidData,
                format!("guest console handle {handle}: status={status}, length={length}, echoed={echoed}")));
        }
        Ok(String::from_utf8_lossy(&reply[16..16 + length]).into_owned())
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
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("fault_inject err {ok}"),
            ));
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
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("trace_start err {ok}"),
            ));
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
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("trace_stop err {ok}"),
            ));
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
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("trace_query err {ok}"),
            ));
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
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("trace_dump err {ok}"),
            ));
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
            // A partial frame cannot be resumed by another command. In
            // particular, input might already have been accepted remotely.
            let _ = self.stream.shutdown(std::net::Shutdown::Both);
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
            let _ = self.stream.shutdown(std::net::Shutdown::Both);
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
        let ok = error.is_none()
            && (!has_ok_mr || reply_mr[0] == 0)
            && (!matches!(opcode, MSG_CC_INPUT_SUBMIT | MSG_CC_FRAME_CAPTURE) || reply_mr[2] == 0);

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
        MSG_CC_INPUT_SUBMIT => "INPUT_SUBMIT",
        MSG_CC_FRAME_CAPTURE => "FRAME_CAPTURE",
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
            | MSG_CC_INPUT_SUBMIT
            | MSG_CC_FRAME_CAPTURE
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
        MSG_CC_INPUT_SUBMIT if mr[0] == 0 => mr[1].min(CC_SHMEM_SIZE as u32),
        MSG_CC_FRAME_CAPTURE if mr[0] == 0 => mr[1].min(CC_SHMEM_SIZE as u32),
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
mod console_tests {
    use super::*;

    #[test]
    fn public_handle_console_validates_wire_status_length_and_identity() {
        for (status, length, echoed, valid) in [
            (0u32, 3u32, 17u32, true),
            (6, 0, 17, false),
            (0, 4097, 17, false),
            (0, 3, 18, false),
        ] {
            let (stream, mut peer) = UnixStream::pair().unwrap();
            let mut client = CcClient {
                stream,
                session_id: 0,
                traffic: VecDeque::new(),
                next_traffic_seq: 0,
                frame: None,
            };
            let server = std::thread::spawn(move || {
                let mut request = [0u8; CC_REQ_SIZE];
                peer.read_exact(&mut request).unwrap();
                let mut expected = [0u8; CC_REQ_SIZE];
                for (i, word) in [MSG_CC_LOG_STREAM, 17, 0, 1].iter().enumerate() {
                    expected[i * 4..i * 4 + 4].copy_from_slice(&word.to_le_bytes());
                }
                assert_eq!(request, expected);
                let mut reply = [0u8; CC_REPLY_SIZE];
                for (i, word) in [status, length, echoed, 0].iter().enumerate() {
                    reply[i * 4..i * 4 + 4].copy_from_slice(&word.to_le_bytes());
                }
                reply[16..19].copy_from_slice(b"abc");
                peer.write_all(&reply).unwrap();
            });
            let result = client.guest_console(17);
            assert_eq!(result.is_ok(), valid);
            if valid {
                assert_eq!(result.unwrap(), "abc");
            }
            server.join().unwrap();
        }
    }
}
