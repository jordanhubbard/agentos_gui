//! Read-only latency probe using the same CC client as the native GUI.
use agentos_gui_lib::cc_ipc::CcClient;
use serde_json::json;
use std::error::Error;
use std::time::Instant;

fn summary(mut samples: Vec<f64>) -> serde_json::Value {
    samples.sort_by(f64::total_cmp);
    let count = samples.len();
    json!({
        "count": count,
        "min_ms": samples[0],
        "median_ms": samples[count / 2],
        "p95_ms": samples[((count * 95).div_ceil(100) - 1).min(count - 1)],
        "max_ms": samples[count - 1],
        "mean_ms": samples.iter().sum::<f64>() / count as f64
    })
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        return Err("usage: frame_benchmark SOCKET GUEST_HANDLE READ_COUNT".into());
    }
    let handle = if let Some(hex) = args[2].strip_prefix("0x") {
        u32::from_str_radix(hex, 16)?
    } else {
        args[2].parse()?
    };
    let count: usize = args[3].parse()?;
    if !(1..=4096).contains(&count) {
        return Err("READ_COUNT must be 1..4096".into());
    }
    let mut client = CcClient::connect(&args[1])?;
    let mut status_times = Vec::new();
    for _ in 0..16 {
        let started = Instant::now();
        client.session_status(None)?;
        status_times.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    let started = Instant::now();
    let frame = client.frame_capture(handle)?;
    let capture_ms = started.elapsed().as_secs_f64() * 1000.0;
    let length = frame.bytes.min(4056);
    let result = (|| -> Result<_, Box<dyn Error>> {
        let mut expected: Option<Vec<u8>> = None;
        let mut reads = Vec::new();
        let mut wire_ms = 0u64;
        let started_all = Instant::now();
        for _ in 0..count {
            let started = Instant::now();
            let pixels = client.frame_read(&frame.token, 0, length)?;
            reads.push(started.elapsed().as_secs_f64() * 1000.0);
            wire_ms += client.traffic_events(Some(1))[0].duration_ms;
            if let Some(previous) = &expected {
                if pixels != *previous {
                    return Err("immutable pixels changed between reads".into());
                }
            } else {
                expected = Some(pixels);
            }
        }
        Ok(json!({
            "schema": "agentos_gui.frame_benchmark.v1",
            "scope": "Repeated reads of one immutable snapshot region; no GUI polling or input",
            "frame": frame,
            "read_bytes": length,
            "payload_bytes": count as u64 * length as u64,
            "capture_ms": capture_ms,
            "status": summary(status_times),
            "reads": summary(reads),
            "read_wall_ms": started_all.elapsed().as_secs_f64() * 1000.0,
            "recorded_wire_ms": wire_ms,
            "pixels_stable": true
        }))
    })();
    let released = client.frame_release(&frame.token);
    let _ = client.disconnect();
    let result = result?;
    released?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
