//! Mirror of agentOS platform/input.h and cc_contract.h, version 1.
//! An acknowledgment covers the whole batch. Never retry a transport error:
//! the service may have consumed the key transition before the reply was lost.
use super::{CcClient, MSG_CC_INPUT_SUBMIT};
use serde::{Deserialize, Serialize};
use std::io;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopInputEvent {
    pub event_type: u16,
    pub code: u16,
    pub value: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputBatchAck {
    /// 0=accepted, 1=bad request, 2=denied, 3=would block (safe to retry).
    pub status: u32,
    pub accepted: u32,
}

fn encode(device: u32, events: &[DesktopInputEvent]) -> io::Result<[u8; 544]> {
    if device > 1 || events.is_empty() || events.len() > 64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "input batch requires device 0 or 1 and 1..64 events",
        ));
    }
    for (i, event) in events.iter().enumerate() {
        let valid = if i == events.len() - 1 {
            event.event_type == 0 && event.code == 0 && event.value == 0
        } else if device == 0 {
            event.event_type == 1
                && (1..=255).contains(&event.code)
                && (0..=2).contains(&event.value)
        } else {
            (event.event_type == 1
                && (0x110..=0x117).contains(&event.code)
                && (0..=1).contains(&event.value))
                || (event.event_type == 2 && [0, 1, 6, 8].contains(&event.code))
        };
        if !valid {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("invalid input event {i}; batch must end with one SYN_REPORT"),
            ));
        }
    }
    let mut wire = [0u8; 544];
    wire[0..4].copy_from_slice(&1u32.to_le_bytes());
    wire[12..16].copy_from_slice(&device.to_le_bytes());
    wire[16..20].copy_from_slice(&(events.len() as u32).to_le_bytes());
    for (i, event) in events.iter().enumerate() {
        let start = 32 + i * 8;
        wire[start..start + 2].copy_from_slice(&event.event_type.to_le_bytes());
        wire[start + 2..start + 4].copy_from_slice(&event.code.to_le_bytes());
        wire[start + 4..start + 8].copy_from_slice(&event.value.to_le_bytes());
    }
    Ok(wire)
}

impl CcClient {
    pub fn input_submit(
        &mut self,
        handle: u32,
        device: u32,
        events: &[DesktopInputEvent],
    ) -> io::Result<InputBatchAck> {
        let wire = encode(device, events)?;
        let reply = self.send_recv(MSG_CC_INPUT_SUBMIT, handle, 0, 0, &wire)?;
        let word = |offset| u32::from_le_bytes(reply[offset..offset + 4].try_into().unwrap());
        if word(0) != 0 {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("CC_INPUT_SUBMIT rejected: {}", word(0)),
            ));
        }
        let status = word(24);
        let accepted = word(28);
        if word(4) != 16
            || word(8) != status
            || word(12) != 1
            || word(16) != 1
            || word(20) != 0
            || status > 3
            || (status == 0 && accepted != events.len() as u32)
            || (status != 0 && accepted != 0)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid CC_INPUT_SUBMIT acknowledgment; input outcome unknown, do not retry",
            ));
        }
        Ok(InputBatchAck { status, accepted })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cc_ipc::{CC_REPLY_SIZE, CC_REQ_SIZE};
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;

    fn events() -> Vec<DesktopInputEvent> {
        vec![
            DesktopInputEvent {
                event_type: 1,
                code: 30,
                value: 1,
            },
            DesktopInputEvent {
                event_type: 0,
                code: 0,
                value: 0,
            },
        ]
    }
    fn client() -> (CcClient, UnixStream) {
        let (stream, peer) = UnixStream::pair().unwrap();
        (
            CcClient {
                stream,
                session_id: 0,
                traffic: VecDeque::new(),
                next_traffic_seq: 0,
            },
            peer,
        )
    }
    fn response(status: u32, accepted: u32) -> [u8; CC_REPLY_SIZE] {
        let mut reply = [0; CC_REPLY_SIZE];
        for (i, value) in [0u32, 16, status, 1, 1, 0, status, accepted]
            .iter()
            .enumerate()
        {
            reply[i * 4..i * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        reply
    }

    #[test]
    fn exact_wire_and_full_acknowledgment() {
        let (mut client, mut peer) = client();
        let server = std::thread::spawn(move || {
            let mut req = [0; CC_REQ_SIZE];
            peer.read_exact(&mut req).unwrap();
            let mut expected = [0; CC_REQ_SIZE];
            expected[0..4].copy_from_slice(&0x261Eu32.to_le_bytes());
            expected[4..8].copy_from_slice(&0x80000001u32.to_le_bytes());
            expected[16] = 1; // version
            expected[32] = 2; // count
            expected[48] = 1; // EV_KEY
            expected[50] = 30; // KEY_A
            expected[52] = 1; // press; remaining bytes include SYN_REPORT
            assert_eq!(req, expected);
            peer.write_all(&response(0, 2)).unwrap();
        });
        let ack = client.input_submit(0x80000001, 0, &events()).unwrap();
        assert_eq!((ack.status, ack.accepted), (0, 2));
        let traffic = client.traffic_events(None);
        assert_eq!(traffic[0].opcode_name, "INPUT_SUBMIT");
        assert_eq!(
            (traffic[0].shmem_in_len, traffic[0].shmem_out_len),
            (544, 16)
        );
        server.join().unwrap();
    }

    #[test]
    fn atomic_acknowledgments_are_strict() {
        for (status, accepted, valid) in [
            (3, 0, true),
            (1, 0, true),
            (2, 0, true),
            (0, 1, false),
            (3, 1, false),
            (4, 0, false),
        ] {
            let (mut client, mut peer) = client();
            let server = std::thread::spawn(move || {
                let mut request = [0; CC_REQ_SIZE];
                peer.read_exact(&mut request).unwrap();
                peer.write_all(&response(status, accepted)).unwrap();
            });
            assert_eq!(client.input_submit(1, 0, &events()).is_ok(), valid);
            server.join().unwrap();
        }
    }

    #[test]
    fn rejects_invalid_batches_and_encodes_signed_pointer_motion() {
        assert!(encode(2, &events()).is_err());
        assert!(encode(0, &[]).is_err());
        assert!(encode(0, &events()[..1]).is_err());
        assert!(encode(0, &vec![events()[1].clone(); 65]).is_err());
        let mut pointer = events();
        pointer[0] = DesktopInputEvent {
            event_type: 2,
            code: 0,
            value: -17,
        };
        assert!(encode(0, &pointer).is_err());
        assert_eq!(
            &encode(1, &pointer).unwrap()[36..40],
            &(-17i32).to_le_bytes()
        );
        pointer[0].code = 3;
        assert!(encode(1, &pointer).is_err());
    }

    #[test]
    fn partial_reply_closes_transport_without_retrying_input() {
        let (mut client, mut peer) = client();
        let server = std::thread::spawn(move || {
            let mut request = [0; CC_REQ_SIZE];
            peer.read_exact(&mut request).unwrap();
            peer.write_all(&response(0, 2)[..8]).unwrap();
            peer.shutdown(std::net::Shutdown::Write).unwrap();
            let mut next = [0; 1];
            assert_eq!(peer.read(&mut next).unwrap(), 0);
        });
        assert!(client.input_submit(1, 0, &events()).is_err());
        assert!(client.input_submit(1, 0, &events()).is_err());
        server.join().unwrap();
    }

    #[test]
    fn rejects_inconsistent_headers_and_nonzero_internal_ids() {
        for offset in [4, 8, 12, 16, 20] {
            let (mut client, mut peer) = client();
            let server = std::thread::spawn(move || {
                let mut request = [0; CC_REQ_SIZE];
                peer.read_exact(&mut request).unwrap();
                let mut reply = response(0, 2);
                reply[offset] ^= 1;
                peer.write_all(&reply).unwrap();
            });
            assert_eq!(
                client.input_submit(1, 0, &events()).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
            server.join().unwrap();
        }
    }
}
