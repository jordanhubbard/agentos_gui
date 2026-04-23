//! agentOS CC-PD IPC client
//!
//! Wire protocol (from agentctl_ng.c / cc_contract.h):
//!   Request:  opcode(4) + mr[3](12) + shmem(4096) = 4112 bytes
//!   Reply:    mr[4](16) + shmem(4096) = 4112 bytes
//!
//! Transport: Unix domain socket at CC_PD_SOCK (default: build/cc_pd.sock)
//! All MSG_CC_* constants mirror agentos.h exactly.

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use serde::{Deserialize, Serialize};

// ── MSG_CC_* opcodes (from agentos.h) ────────────────────────────────────────
pub const MSG_CC_CONNECT:            u32 = 0x2601;
pub const MSG_CC_DISCONNECT:         u32 = 0x2602;
pub const MSG_CC_STATUS:             u32 = 0x2605;
pub const MSG_CC_LIST:               u32 = 0x2606;
pub const MSG_CC_LIST_GUESTS:        u32 = 0x2607;
pub const MSG_CC_LIST_DEVICES:       u32 = 0x2608;
pub const MSG_CC_LIST_POLECATS:      u32 = 0x2609;
pub const MSG_CC_GUEST_STATUS:       u32 = 0x260A;
pub const MSG_CC_DEVICE_STATUS:      u32 = 0x260B;
pub const MSG_CC_ATTACH_FRAMEBUFFER: u32 = 0x260C;
pub const MSG_CC_SEND_INPUT:         u32 = 0x260D;
pub const MSG_CC_SNAPSHOT:           u32 = 0x260E;
pub const MSG_CC_RESTORE:            u32 = 0x260F;
pub const MSG_CC_LOG_STREAM:         u32 = 0x2610;

// ── Device type constants (CC_DEV_TYPE_*) ────────────────────────────────────
pub const CC_DEV_TYPE_SERIAL: u32 = 0;
pub const CC_DEV_TYPE_NET:    u32 = 1;
pub const CC_DEV_TYPE_BLOCK:  u32 = 2;
pub const CC_DEV_TYPE_USB:    u32 = 3;
pub const CC_DEV_TYPE_FB:     u32 = 4;
pub const CC_DEV_TYPE_COUNT:  u32 = 5;

// ── Wire frame sizes ──────────────────────────────────────────────────────────
const CC_SHMEM_SIZE: usize = 4096;
const CC_REQ_SIZE:   usize = 4 + 12 + CC_SHMEM_SIZE;   // 4112
const CC_REPLY_SIZE: usize = 16 + CC_SHMEM_SIZE;        // 4112

// ── Serde types for Tauri ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuestInfo {
    pub guest_handle: u32,
    pub state:        u32,
    pub os_type:      u32,
    pub arch:         u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub dev_type:   u32,
    pub dev_handle: u32,
    pub state:      u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuestStatus {
    pub guest_handle: u32,
    pub state:        u32,
    pub os_type:      u32,
    pub arch:         u32,
    pub device_flags: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoecatStatus {
    pub total: u32,
    pub busy:  u32,
    pub idle:  u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceStatusInfo {
    pub dev_type:   u32,
    pub dev_handle: u32,
    pub state:      u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapResult {
    pub snap_lo: u32,
    pub snap_hi: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputEvent {
    pub event_type: u32,
    pub keycode:    u32,
    pub dx:         i32,
    pub dy:         i32,
    pub btn_mask:   u32,
}

// ── IPC client ────────────────────────────────────────────────────────────────

pub struct CcClient {
    stream:     UnixStream,
    session_id: u32,
}

impl CcClient {
    pub fn connect(sock_path: &str) -> io::Result<Self> {
        let stream = UnixStream::connect(sock_path)?;
        let mut client = CcClient { stream, session_id: 0 };

        // MSG_CC_CONNECT — establish session
        let reply = client.send_recv(MSG_CC_CONNECT, 0xA6E70002, 0, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(io::Error::new(io::ErrorKind::ConnectionRefused,
                format!("CC_CONNECT rejected: {ok}")));
        }
        client.session_id = u32::from_le_bytes(reply[4..8].try_into().unwrap());
        Ok(client)
    }

    pub fn disconnect(&mut self) -> io::Result<()> {
        let _ = self.send_recv(MSG_CC_DISCONNECT, self.session_id, 0, 0, &[]);
        Ok(())
    }

    pub fn list_guests(&mut self) -> io::Result<Vec<GuestInfo>> {
        let reply = self.send_recv(MSG_CC_LIST_GUESTS, 16, 0, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 { return Ok(vec![]); }
        let count = u32::from_le_bytes(reply[4..8].try_into().unwrap()) as usize;
        let shmem = &reply[16..];
        const ENTRY: usize = 16; // cc_guest_info_t: 4 × u32
        let mut out = Vec::with_capacity(count);
        for i in 0..count.min(shmem.len() / ENTRY) {
            let b = &shmem[i * ENTRY..];
            out.push(GuestInfo {
                guest_handle: u32::from_le_bytes(b[0..4].try_into().unwrap()),
                state:        u32::from_le_bytes(b[4..8].try_into().unwrap()),
                os_type:      u32::from_le_bytes(b[8..12].try_into().unwrap()),
                arch:         u32::from_le_bytes(b[12..16].try_into().unwrap()),
            });
        }
        Ok(out)
    }

    pub fn list_devices(&mut self, dev_type: u32) -> io::Result<Vec<DeviceInfo>> {
        let reply = self.send_recv(MSG_CC_LIST_DEVICES, dev_type, 32, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 { return Ok(vec![]); }
        let count = u32::from_le_bytes(reply[4..8].try_into().unwrap()) as usize;
        let shmem = &reply[16..];
        const ENTRY: usize = 16; // cc_device_info_t: 4 × u32
        let mut out = Vec::with_capacity(count);
        for i in 0..count.min(shmem.len() / ENTRY) {
            let b = &shmem[i * ENTRY..];
            out.push(DeviceInfo {
                dev_type:   u32::from_le_bytes(b[0..4].try_into().unwrap()),
                dev_handle: u32::from_le_bytes(b[4..8].try_into().unwrap()),
                state:      u32::from_le_bytes(b[8..12].try_into().unwrap()),
            });
        }
        Ok(out)
    }

    pub fn guest_status(&mut self, handle: u32) -> io::Result<GuestStatus> {
        let reply = self.send_recv(MSG_CC_GUEST_STATUS, handle, 0, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(io::Error::new(io::ErrorKind::Other, format!("guest_status err {ok}")));
        }
        let b = &reply[16..];
        Ok(GuestStatus {
            guest_handle: u32::from_le_bytes(b[0..4].try_into().unwrap()),
            state:        u32::from_le_bytes(b[4..8].try_into().unwrap()),
            os_type:      u32::from_le_bytes(b[8..12].try_into().unwrap()),
            arch:         u32::from_le_bytes(b[12..16].try_into().unwrap()),
            device_flags: u32::from_le_bytes(b[16..20].try_into().unwrap()),
        })
    }

    pub fn list_polecats(&mut self) -> io::Result<PoecatStatus> {
        let reply = self.send_recv(MSG_CC_LIST_POLECATS, 0, 0, 0, &[])?;
        let ok    = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 { return Ok(PoecatStatus { total: 0, busy: 0, idle: 0 }); }
        Ok(PoecatStatus {
            total: u32::from_le_bytes(reply[4..8].try_into().unwrap()),
            busy:  u32::from_le_bytes(reply[8..12].try_into().unwrap()),
            idle:  u32::from_le_bytes(reply[12..16].try_into().unwrap()),
        })
    }

    pub fn snapshot(&mut self, handle: u32) -> io::Result<SnapResult> {
        let reply = self.send_recv(MSG_CC_SNAPSHOT, handle, 0, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(io::Error::new(io::ErrorKind::Other, format!("snapshot err {ok}")));
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
            return Err(io::Error::new(io::ErrorKind::Other, format!("restore err {ok}")));
        }
        Ok(())
    }

    pub fn log_stream(&mut self, slot: u32, pd_id: u32) -> io::Result<String> {
        let reply = self.send_recv(MSG_CC_LOG_STREAM, slot, pd_id, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 { return Ok(String::new()); }
        let bytes = u32::from_le_bytes(reply[4..8].try_into().unwrap()) as usize;
        let shmem = &reply[16..];
        let end = bytes.min(shmem.len());
        let s = std::str::from_utf8(&shmem[..end]).unwrap_or("(invalid utf8)").to_string();
        Ok(s)
    }

    pub fn device_status(&mut self, dev_type: u32, dev_handle: u32)
        -> io::Result<DeviceStatusInfo>
    {
        let reply = self.send_recv(MSG_CC_DEVICE_STATUS, dev_type, dev_handle, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(io::Error::new(io::ErrorKind::Other,
                format!("device_status err {ok}")));
        }
        let b = &reply[16..];
        Ok(DeviceStatusInfo {
            dev_type:   u32::from_le_bytes(b[0..4].try_into().unwrap()),
            dev_handle: u32::from_le_bytes(b[4..8].try_into().unwrap()),
            state:      u32::from_le_bytes(b[8..12].try_into().unwrap()),
        })
    }

    pub fn attach_framebuffer(&mut self, guest_handle: u32, fb_handle: u32)
        -> io::Result<u32>
    {
        let reply = self.send_recv(MSG_CC_ATTACH_FRAMEBUFFER, guest_handle, fb_handle, 0, &[])?;
        let ok = u32::from_le_bytes(reply[0..4].try_into().unwrap());
        if ok != 0 {
            return Err(io::Error::new(io::ErrorKind::Other,
                format!("attach_framebuffer err {ok}")));
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
            return Err(io::Error::new(io::ErrorKind::Other, format!("send_input err {ok}")));
        }
        Ok(())
    }

    // ── Low-level send/recv ───────────────────────────────────────────────────

    fn send_recv(&mut self, opcode: u32, mr1: u32, mr2: u32, mr3: u32,
                 shmem_in: &[u8]) -> io::Result<[u8; CC_REPLY_SIZE]> {
        let mut req = [0u8; CC_REQ_SIZE];
        req[0..4].copy_from_slice(&opcode.to_le_bytes());
        req[4..8].copy_from_slice(&mr1.to_le_bytes());
        req[8..12].copy_from_slice(&mr2.to_le_bytes());
        req[12..16].copy_from_slice(&mr3.to_le_bytes());
        let copy_len = shmem_in.len().min(CC_SHMEM_SIZE);
        if copy_len > 0 {
            req[16..16 + copy_len].copy_from_slice(&shmem_in[..copy_len]);
        }

        self.stream.write_all(&req)?;

        let mut reply = [0u8; CC_REPLY_SIZE];
        self.stream.read_exact(&mut reply)?;
        Ok(reply)
    }
}
