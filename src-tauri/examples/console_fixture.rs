//! Native-renderer fixture, not an agentOS guest qualification.
//! Run with a fresh socket path, then point `make run CC_PD_SOCK=...` at it.
//! Drain more than 300 chunks; NATIVE-ROLLOVER must remain visible and advance.
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;

fn word(reply: &mut [u8], offset: usize, value: u32) {
    reply[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn main() -> std::io::Result<()> {
    let path = std::env::args()
        .nth(1)
        .expect("fresh Unix socket path required");
    let listener = UnixListener::bind(path)?;
    let mut count = 0u32;
    for stream in listener.incoming() {
        let mut stream = stream?;
        loop {
            let mut request = [0u8; 4112];
            if stream.read_exact(&mut request).is_err() {
                break;
            }
            let opcode = u32::from_le_bytes(request[..4].try_into().unwrap());
            let mut reply = [0u8; 4112];
            match opcode {
                0x2607 | 0x260a => {
                    if opcode == 0x2607 {
                        word(&mut reply, 0, 1);
                    }
                    for (i, value) in [1, 4, 1, 1, 0].iter().enumerate() {
                        word(&mut reply, 16 + i * 4, *value);
                    }
                }
                0x2610 => {
                    count += 1;
                    let text = if count <= 305 {
                        "r".to_string()
                    } else {
                        format!("\r\nNATIVE-ROLLOVER-{count}\r\n")
                    };
                    word(&mut reply, 4, text.len() as u32);
                    word(&mut reply, 8, 1);
                    reply[16..16 + text.len()].copy_from_slice(text.as_bytes());
                    println!("console chunk {count}");
                }
                0x2601..=0x2606 | 0x2608 | 0x2609 | 0x2618 | 0x2619 => {}
                _ => word(&mut reply, 0, 9),
            }
            if stream.write_all(&reply).is_err() {
                break;
            }
        }
    }
    Ok(())
}
