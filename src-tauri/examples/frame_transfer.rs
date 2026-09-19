//! Compare complete raw and GUI-batched reads of the same immutable snapshot.
use agentos_gui_lib::cc_ipc::CcClient;
use serde_json::json;
use std::{error::Error, io::Read, time::Instant};

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 4 || !matches!(args[3].as_str(), "raw-first" | "packed-first") {
        return Err("usage: frame_transfer SOCKET GUEST_HANDLE raw-first|packed-first".into());
    }
    let handle = if let Some(hex) = args[2].strip_prefix("0x") {
        u32::from_str_radix(hex, 16)?
    } else {
        args[2].parse()?
    };
    let reference = if let Some(path) = std::env::var_os("FRAME_REFERENCE") {
        let mut pixels = Vec::new();
        std::fs::File::open(path)?
            .take(1024 * 768 * 4 + 1)
            .read_to_end(&mut pixels)?;
        if pixels.is_empty() || pixels.len() > 1024 * 768 * 4 || pixels.len() % 4 != 0 {
            return Err("FRAME_REFERENCE must contain at most 3 MiB of XRGB8888 pixels".into());
        }
        Some(pixels)
    } else {
        None
    };
    let reference_checked = reference.is_some();
    let mut client = CcClient::connect(&args[1])?;
    let frame = client.frame_capture(handle)?;
    let result = (|| -> Result<_, Box<dyn Error>> {
        let mut expected = reference;
        if expected
            .as_ref()
            .is_some_and(|pixels| pixels.len() != frame.bytes as usize)
        {
            return Err("FRAME_REFERENCE dimensions do not match captured frame".into());
        }
        let mut passes = Vec::new();
        let packed_first = args[3] == "packed-first";
        for packed in [packed_first, !packed_first] {
            let started = Instant::now();
            let mut pixels = Vec::with_capacity(frame.bytes as usize);
            let mut calls = 0u32;
            while pixels.len() < frame.bytes as usize {
                let offset = pixels.len() as u32;
                let remaining = frame.bytes - offset;
                let chunk = if packed {
                    client.frame_read_batch(&frame.token, offset, remaining.min(8 * 4056))?
                } else {
                    client.frame_read(&frame.token, offset, remaining.min(4056))?
                };
                if chunk.is_empty() || chunk.len() > remaining as usize {
                    return Err("invalid frame prefix progress".into());
                }
                pixels.extend_from_slice(&chunk);
                calls += 1;
            }
            passes.push(json!({"mode": if packed {"gui_batch"} else {"raw"},
                "milliseconds": started.elapsed().as_secs_f64()*1000.0,
                "client_calls": calls, "bytes": pixels.len()}));
            if let Some(previous) = &expected {
                if previous != &pixels {
                    return Err("frame pixel comparison failed".into());
                }
            } else {
                expected = Some(pixels);
            }
        }
        Ok(
            json!({"schema":"agentos_gui.frame_transfer.v1", "frame":frame,
            "scope":"Full immutable snapshot, production CC client; no GUI rendering or input",
            "order":args[3], "passes":passes, "pixels_equal":true,
            "reference_checked":reference_checked}),
        )
    })();
    let released = client.frame_release(&frame.token);
    let _ = client.disconnect();
    let result = result?;
    released?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
