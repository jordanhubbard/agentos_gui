//! Immutable XRGB8888 observer stream from framebuffer_observer.h, version 1.
use super::{CcClient, MSG_CC_FRAME_CAPTURE};
use serde::Serialize;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const FRAME_WIRE_BYTES: u32 = 4056;
const FRAME_BATCH_BYTES: u32 = 8 * FRAME_WIRE_BYTES;
const FRAME_BATCH_BUDGET: Duration = Duration::from_millis(25);
const FRAME_PACKED_MAX: u32 = 65536;
const CC_ERR_INVALID_ARG: u32 = 9;

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
    packed_available: bool,
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

/// Decode the optional READ_PACKED prefix without accepting padding, zero
/// runs, expansion beyond the request, or truncated records.
fn decode_packed(wire: &[u8], limit: u32) -> io::Result<Vec<u8>> {
    if wire.len() < 12 || wire.len() > FRAME_WIRE_BYTES as usize {
        return Err(invalid("invalid packed frame size"));
    }
    let decoded = u32::from_le_bytes(wire[..4].try_into().unwrap());
    let encoding = u32::from_le_bytes(wire[4..8].try_into().unwrap());
    if decoded == 0 || decoded % 4 != 0 || decoded > limit || decoded > FRAME_PACKED_MAX {
        return Err(invalid("invalid packed frame expansion"));
    }
    let body = &wire[8..];
    match encoding {
        0 if body.len() == decoded as usize => Ok(body.to_vec()),
        1 if body.len() % 8 == 0 => {
            let mut pixels = Vec::with_capacity(decoded as usize);
            for run in body.chunks_exact(8) {
                let count = u32::from_le_bytes(run[..4].try_into().unwrap());
                if count == 0 || count > (decoded - pixels.len() as u32) / 4 {
                    return Err(invalid("invalid packed frame run"));
                }
                for _ in 0..count {
                    pixels.extend_from_slice(&run[4..]);
                }
            }
            if pixels.len() != decoded as usize {
                return Err(invalid("incomplete packed frame"));
            }
            Ok(pixels)
        }
        _ => Err(invalid("invalid packed frame encoding")),
    }
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
                if op == 4 && word(0) == CC_ERR_INVALID_ARG {
                    io::ErrorKind::Unsupported
                } else {
                    io::ErrorKind::Other
                },
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
        if op != 4 && payload != length {
            return Err(invalid("frame observer returned an unexpected byte count"));
        }
        Ok(Response {
            cookie: long(32),
            sequence: long(40),
            width: word(48),
            height: word(52),
            pixels: if op == 4 {
                decode_packed(&reply[56..56 + payload as usize], length)?
            } else {
                reply[56..56 + payload as usize].to_vec()
            },
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
            packed_available: true,
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

    fn frame_read_prefix(&mut self, token: &str, offset: u32, length: u32) -> io::Result<Vec<u8>> {
        let snap = self.frame_snapshot(token)?;
        if snap.packed_available && offset % 4 == 0 && length % 4 == 0 {
            match self.observer(0, 4, snap.cookie, offset, length.min(FRAME_PACKED_MAX)) {
                Ok(reply) => {
                    if reply.cookie != snap.cookie
                        || reply.sequence != snap.sequence
                        || reply.width != snap.info.width
                        || reply.height != snap.info.height
                    {
                        return Err(invalid("frame changed during packed capture"));
                    }
                    return Ok(reply.pixels);
                }
                Err(error) if error.kind() == io::ErrorKind::Unsupported => {
                    // Only an explicit legacy CC rejection permits fallback.
                    // Malformed data and transport errors propagate unchanged.
                    self.frame.as_mut().unwrap().packed_available = false;
                }
                Err(error) => return Err(error),
            }
        }
        self.frame_read(token, offset, length.min(FRAME_WIRE_BYTES))
    }

    /// Aggregate bounded wire reads for one browser IPC response. Return a
    /// nonempty prefix once the time budget expires, releasing the client lock
    /// between batches so input and cancellation are not held behind a frame.
    /// A single in-flight wire request still uses the ordinary socket timeout.
    pub fn frame_read_batch(
        &mut self,
        token: &str,
        offset: u32,
        length: u32,
    ) -> io::Result<Vec<u8>> {
        self.frame_read_batch_budget(token, offset, length, FRAME_BATCH_BUDGET)
    }

    fn frame_read_batch_budget(
        &mut self,
        token: &str,
        offset: u32,
        length: u32,
        budget: Duration,
    ) -> io::Result<Vec<u8>> {
        let snap = self.frame_snapshot(token)?;
        if length == 0
            || length > FRAME_BATCH_BYTES
            || offset > snap.info.bytes
            || length > snap.info.bytes - offset
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "frame batch exceeds snapshot bounds",
            ));
        }
        let started = Instant::now();
        let mut pixels = Vec::with_capacity(length as usize);
        while pixels.len() < length as usize {
            let done = pixels.len() as u32;
            let bytes = self.frame_read_prefix(token, offset + done, length - done)?;
            pixels.extend_from_slice(&bytes);
            if started.elapsed() >= budget {
                break;
            }
        }
        Ok(pixels)
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

    fn reject_packed(peer: &mut UnixStream, length: u32) {
        request(peer, 0, 4, 5, 0, length);
        let mut rejected = [0u8; CC_REPLY_SIZE];
        rejected[..4].copy_from_slice(&9u32.to_le_bytes());
        peer.write_all(&rejected).unwrap();
    }

    #[test]
    fn packed_decoder_rejects_invalid_expansion_and_accepts_exact_pixels() {
        let run = [8, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 2, 1, 0];
        assert_eq!(decode_packed(&run, 8).unwrap(), [3, 2, 1, 0, 3, 2, 1, 0]);
        assert_eq!(
            decode_packed(&[4, 0, 0, 0, 0, 0, 0, 0, 9, 8, 7, 6], 4).unwrap(),
            [9, 8, 7, 6]
        );
        for len in 0..run.len() {
            assert!(decode_packed(&run[..len], 8).is_err());
        }
        for (offset, value) in [
            (0, 0),
            (0, 7),
            (0, 12),
            (4, 2),
            (8, 0),
            (8, 1),
            (8, 3),
            (8, 255),
        ] {
            let mut bad = run;
            bad[offset] = value;
            assert!(decode_packed(&bad, 8).is_err());
        }
        assert!(decode_packed(&run, 4).is_err());
        let mut trailing = run.to_vec();
        trailing.extend_from_slice(&[0; 8]);
        assert!(decode_packed(&trailing, 8).is_err());
    }

    #[test]
    fn packed_batch_reconstructs_prefixes_and_does_not_mask_bad_replies() {
        for malformed in [false, true] {
            let (mut client, mut peer) = pair();
            let server = std::thread::spawn(move || {
                request(&mut peer, 1, 1, 0, 0, 0);
                peer.write_all(&reply(5, &[])).unwrap();
                request(&mut peer, 0, 4, 5, 0, 8);
                let mut packed = vec![4, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 3, 2, 1, 0];
                if malformed {
                    packed[8] = 0;
                }
                peer.write_all(&reply(5, &packed)).unwrap();
                if !malformed {
                    request(&mut peer, 0, 4, 5, 4, 4);
                    peer.write_all(&reply(5, &[4, 0, 0, 0, 0, 0, 0, 0, 7, 6, 5, 4]))
                        .unwrap();
                }
                // Malformed replies must reach the caller without a raw retry.
                request(&mut peer, 0, 3, 5, 0, 0);
                peer.write_all(&reply(0, &[])).unwrap();
            });
            let frame = client.frame_capture(1).unwrap();
            let pixels = client.frame_read_batch_budget(&frame.token, 0, 8, Duration::MAX);
            if malformed {
                assert_eq!(pixels.unwrap_err().kind(), io::ErrorKind::InvalidData);
            } else {
                assert_eq!(pixels.unwrap(), [3, 2, 1, 0, 7, 6, 5, 4]);
            }
            client.frame_release(&frame.token).unwrap();
            server.join().unwrap();
        }
    }

    #[test]
    fn batches_exact_wire_chunks_without_changing_snapshot_pixels() {
        let (mut client, mut peer) = pair();
        let sized_reply = |pixels: &[u8]| {
            let mut data = reply(5, pixels);
            data[48..52].copy_from_slice(&1024u32.to_le_bytes());
            data[52..56].copy_from_slice(&8u32.to_le_bytes());
            data
        };
        let server = std::thread::spawn(move || {
            request(&mut peer, 1, 1, 0, 0, 0);
            peer.write_all(&sized_reply(&[])).unwrap();
            reject_packed(&mut peer, FRAME_BATCH_BYTES);
            for chunk in 0..8u32 {
                let offset = chunk * FRAME_WIRE_BYTES;
                request(&mut peer, 0, 2, 5, offset, FRAME_WIRE_BYTES);
                let bytes: Vec<_> = (offset..offset + FRAME_WIRE_BYTES)
                    .map(|i| (i % 251) as u8)
                    .collect();
                peer.write_all(&sized_reply(&bytes)).unwrap();
            }
            request(&mut peer, 0, 3, 5, 0, 0);
            let mut released = sized_reply(&[]);
            released[32..40].copy_from_slice(&0u64.to_le_bytes());
            peer.write_all(&released).unwrap();
        });
        let frame = client.frame_capture(1).unwrap();
        for (offset, length) in [
            (0, 0),
            (0, FRAME_BATCH_BYTES + 1),
            (32767, 2),
            (u32::MAX, 1),
        ] {
            assert!(client
                .frame_read_batch(&frame.token, offset, length)
                .is_err());
        }
        let pixels = client
            .frame_read_batch_budget(&frame.token, 0, FRAME_BATCH_BYTES, Duration::MAX)
            .unwrap();
        assert_eq!(
            pixels,
            (0..FRAME_BATCH_BYTES)
                .map(|i| (i % 251) as u8)
                .collect::<Vec<_>>()
        );
        client.frame_release(&frame.token).unwrap();
        assert!(client.frame_read_batch(&frame.token, 0, 4).is_err());
        server.join().unwrap();
    }

    #[test]
    fn batch_yields_at_budget_and_rejects_mid_batch_metadata_changes() {
        for fail in [false, true] {
            let (mut client, mut peer) = pair();
            let sized_reply = |pixels: &[u8]| {
                let mut data = reply(5, pixels);
                data[48..52].copy_from_slice(&1024u32.to_le_bytes());
                data[52..56].copy_from_slice(&2u32.to_le_bytes());
                data
            };
            let server = std::thread::spawn(move || {
                request(&mut peer, 1, 1, 0, 0, 0);
                peer.write_all(&sized_reply(&[])).unwrap();
                reject_packed(&mut peer, 8192);
                request(&mut peer, 0, 2, 5, 0, FRAME_WIRE_BYTES);
                peer.write_all(&sized_reply(&vec![7; FRAME_WIRE_BYTES as usize]))
                    .unwrap();
                if fail {
                    request(&mut peer, 0, 2, 5, FRAME_WIRE_BYTES, FRAME_WIRE_BYTES);
                    let mut bad = sized_reply(&vec![8; FRAME_WIRE_BYTES as usize]);
                    bad[40] ^= 1;
                    peer.write_all(&bad).unwrap();
                }
                request(&mut peer, 0, 3, 5, 0, 0);
                let mut released = sized_reply(&[]);
                released[32..40].copy_from_slice(&0u64.to_le_bytes());
                peer.write_all(&released).unwrap();
            });
            let frame = client.frame_capture(1).unwrap();
            let pixels = client.frame_read_batch_budget(
                &frame.token,
                0,
                8192,
                if fail { Duration::MAX } else { Duration::ZERO },
            );
            if fail {
                assert!(pixels.is_err());
            } else {
                assert_eq!(pixels.unwrap(), vec![7; FRAME_WIRE_BYTES as usize]);
            }
            client.frame_release(&frame.token).unwrap();
            server.join().unwrap();
        }
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
