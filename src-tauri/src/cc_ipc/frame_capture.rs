//! Immutable XRGB8888 observer stream from framebuffer_observer.h, version 1.
use super::{CcClient, MSG_CC_FRAME_CAPTURE};
use serde::Serialize;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};

// Process-local tokens never expose or reuse a server cookie after reconnect.
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Serialize)]
pub struct FrameInfo {
    pub token: String,
    pub sequence: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u32,
}

#[derive(Clone)]
pub(super) struct Snapshot {
    info: FrameInfo,
    cookie: u64,
    sequence: u64,
}

struct Response {
    cookie: u64,
    sequence: u64,
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

impl CcClient {
    fn observer(
        &mut self,
        handle: u32,
        op: u32,
        cookie: u64,
        offset: u32,
        length: u32,
    ) -> io::Result<Response> {
        let mut request = [0u8; 32];
        request[0..4].copy_from_slice(&1u32.to_le_bytes());
        request[4..8].copy_from_slice(&op.to_le_bytes());
        request[16..24].copy_from_slice(&cookie.to_le_bytes());
        request[24..28].copy_from_slice(&offset.to_le_bytes());
        request[28..32].copy_from_slice(&length.to_le_bytes());
        let reply = self.send_recv(MSG_CC_FRAME_CAPTURE, handle, 0, 0, &request)?;
        let word = |offset| u32::from_le_bytes(reply[offset..offset + 4].try_into().unwrap());
        let long = |offset| u64::from_le_bytes(reply[offset..offset + 8].try_into().unwrap());
        if word(0) != 0 {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("CC_FRAME_CAPTURE rejected: {}", word(0)),
            ));
        }
        let payload = word(28);
        if word(12) != 1
            || word(16) != 1
            || word(24) != 0
            || word(8) != word(20)
            || payload > 4056
            || word(4) != 40 + payload
        {
            return Err(invalid("invalid frame observer reply header"));
        }
        if word(20) != 0 {
            if payload != 0 || word(20) > 6 {
                return Err(invalid("invalid frame observer error reply"));
            }
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("frame observer status {}", word(20)),
            ));
        }
        if payload != length {
            return Err(invalid("frame observer returned an unexpected byte count"));
        }
        Ok(Response {
            cookie: long(32),
            sequence: long(40),
            width: word(48),
            height: word(52),
            pixels: reply[56..56 + payload as usize].to_vec(),
        })
    }

    pub fn frame_capture(&mut self, handle: u32) -> io::Result<FrameInfo> {
        if self.frame.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "release the active frame before capturing another",
            ));
        }
        let token = NEXT_TOKEN
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| v.checked_add(1))
            .map_err(|_| invalid("frame token space exhausted"))?;
        let reply = self.observer(handle, 1, 0, 0, 0)?;
        if reply.cookie == 0
            || reply.sequence == 0
            || reply.width == 0
            || reply.height == 0
            || reply.width > 1024
            || reply.height > 768
        {
            return Err(invalid("invalid frame dimensions, sequence or cookie"));
        }
        let info = FrameInfo {
            token: token.to_string(),
            sequence: reply.sequence.to_string(),
            width: reply.width,
            height: reply.height,
            bytes: reply.width * reply.height * 4,
        };
        self.frame = Some(Snapshot {
            info: info.clone(),
            cookie: reply.cookie,
            sequence: reply.sequence,
        });
        Ok(info)
    }

    fn frame_snapshot(&self, token: &str) -> io::Result<Snapshot> {
        self.frame
            .as_ref()
            .filter(|s| s.info.token == token)
            .cloned()
            .ok_or_else(|| invalid("stale or released frame token"))
    }

    pub fn frame_read(&mut self, token: &str, offset: u32, length: u32) -> io::Result<Vec<u8>> {
        let snap = self.frame_snapshot(token)?;
        if length == 0
            || length > 4056
            || offset > snap.info.bytes
            || length > snap.info.bytes - offset
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "frame read exceeds snapshot bounds",
            ));
        }
        let reply = self.observer(0, 2, snap.cookie, offset, length)?;
        if reply.cookie != snap.cookie
            || reply.sequence != snap.sequence
            || reply.width != snap.info.width
            || reply.height != snap.info.height
        {
            return Err(invalid("frame changed during immutable capture"));
        }
        Ok(reply.pixels)
    }

    pub fn frame_release(&mut self, token: &str) -> io::Result<()> {
        let snap = self.frame_snapshot(token)?;
        // Even failed releases must not leave this client permanently busy.
        // A fresh CAPTURE replaces the service's previous snapshot.
        self.frame = None;
        let reply = self.observer(0, 3, snap.cookie, 0, 0)?;
        if reply.cookie != 0
            || reply.sequence != snap.sequence
            || reply.width != snap.info.width
            || reply.height != snap.info.height
        {
            return Err(invalid("invalid frame release acknowledgment"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cc_ipc::{CC_REPLY_SIZE, CC_REQ_SIZE};
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;

    fn pair() -> (CcClient, UnixStream) {
        let (stream, peer) = UnixStream::pair().unwrap();
        (
            CcClient {
                stream,
                session_id: 0,
                traffic: VecDeque::new(),
                next_traffic_seq: 0,
                frame: None,
            },
            peer,
        )
    }
    fn reply(cookie: u64, pixels: &[u8]) -> [u8; CC_REPLY_SIZE] {
        let mut result = [0u8; CC_REPLY_SIZE];
        for (offset, value) in [
            (4, 40 + pixels.len() as u32),
            (12, 1),
            (16, 1),
            (28, pixels.len() as u32),
            (48, 2),
            (52, 1),
        ] {
            result[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        result[32..40].copy_from_slice(&cookie.to_le_bytes());
        result[40..48].copy_from_slice(&u64::MAX.to_le_bytes());
        result[56..56 + pixels.len()].copy_from_slice(pixels);
        result
    }
    fn request(peer: &mut UnixStream, handle: u32, op: u32, cookie: u64, offset: u32, length: u32) {
        let mut actual = [0; CC_REQ_SIZE];
        peer.read_exact(&mut actual).unwrap();
        let mut expected = [0; CC_REQ_SIZE];
        for (offset, value) in [
            (0, 0x261Du32),
            (4, handle),
            (16, 1),
            (20, op),
            (40, offset),
            (44, length),
        ] {
            expected[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        expected[32..40].copy_from_slice(&cookie.to_le_bytes());
        assert_eq!(actual, expected);
    }

    #[test]
    fn capture_read_release_exact_wire_and_pixels() {
        let (mut client, mut peer) = pair();
        let server = std::thread::spawn(move || {
            request(&mut peer, 0x80000001, 1, 0, 0, 0);
            peer.write_all(&reply(u64::MAX, &[])).unwrap();
            request(&mut peer, 0, 2, u64::MAX, 4, 4);
            peer.write_all(&reply(u64::MAX, &[3, 2, 1, 0])).unwrap();
            request(&mut peer, 0, 3, u64::MAX, 0, 0);
            peer.write_all(&reply(0, &[])).unwrap();
        });
        let frame = client.frame_capture(0x80000001).unwrap();
        assert_eq!((frame.width, frame.height, frame.bytes), (2, 1, 8));
        assert_eq!(frame.sequence, u64::MAX.to_string());
        assert!(client.frame_capture(2).is_err());
        assert!(client.frame_read("stale", 0, 4).is_err());
        assert!(client.frame_release("stale").is_err());
        assert!(client.frame_read(&frame.token, u32::MAX, 4).is_err());
        assert!(client.frame_read(&frame.token, 0, 4057).is_err());
        assert_eq!(client.frame_read(&frame.token, 4, 4).unwrap(), [3, 2, 1, 0]);
        client.frame_release(&frame.token).unwrap();
        assert!(client.frame_read(&frame.token, 0, 4).is_err());
        server.join().unwrap();
    }

    #[test]
    fn rejects_changed_metadata_and_still_releases() {
        for offset in [32, 40, 48, 52] {
            let (mut client, mut peer) = pair();
            let server = std::thread::spawn(move || {
                request(&mut peer, 1, 1, 0, 0, 0);
                peer.write_all(&reply(5, &[])).unwrap();
                request(&mut peer, 0, 2, 5, 0, 4);
                let mut changed = reply(5, &[0; 4]);
                changed[offset] ^= 1;
                peer.write_all(&changed).unwrap();
                request(&mut peer, 0, 3, 5, 0, 0);
                peer.write_all(&reply(0, &[])).unwrap();
            });
            let frame = client.frame_capture(1).unwrap();
            assert!(client.frame_read(&frame.token, 0, 4).is_err());
            client.frame_release(&frame.token).unwrap();
            server.join().unwrap();
        }
    }

    #[test]
    fn reconnect_does_not_reuse_tokens_even_if_server_cookie_repeats() {
        let mut previous: Option<String> = None;
        for _ in 0..2 {
            let (mut client, mut peer) = pair();
            let server = std::thread::spawn(move || {
                request(&mut peer, 1, 1, 0, 0, 0);
                peer.write_all(&reply(1, &[])).unwrap();
                request(&mut peer, 0, 3, 1, 0, 0);
                peer.write_all(&reply(0, &[])).unwrap();
            });
            let frame = client.frame_capture(1).unwrap();
            if let Some(old) = previous {
                assert_ne!(frame.token, old);
                assert!(client.frame_read(&old, 0, 4).is_err());
                assert!(client.frame_release(&old).is_err());
            }
            client.frame_release(&frame.token).unwrap();
            previous = Some(frame.token);
            server.join().unwrap();
        }
    }

    #[test]
    fn rejects_oversized_payload_and_invalid_dimensions() {
        for (offset, value) in [
            (28, 4057u32),
            (4, 39),
            (12, 2),
            (24, 1),
            (48, 1025),
            (52, 0),
        ] {
            let (mut client, mut peer) = pair();
            let server = std::thread::spawn(move || {
                request(&mut peer, 1, 1, 0, 0, 0);
                let mut bad = reply(1, &[]);
                bad[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
                peer.write_all(&bad).unwrap();
            });
            assert_eq!(
                client.frame_capture(1).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
            server.join().unwrap();
        }
    }
}
