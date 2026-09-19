//! Measure native X11 key injection through the GUI to guest evdev receipts.
//! Focus the GUI display first. Pass SSH arguments ending in the guest probe's
//! --gui-latency command; the probe must emit the strict receipt protocol.
use serde_json::json;
use std::{
    error::Error,
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

struct Session {
    ssh: Child,
    injected: bool,
}
impl Drop for Session {
    fn drop(&mut self) {
        if self.injected {
            let _ = Command::new("xdotool").args(["keyup", "F12"]).status();
        }
        let _ = self.ssh.kill();
        let _ = self.ssh.wait();
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.is_empty() {
        return Err("usage: native_input_latency SSH_ARGS... HOST PROBE --gui-latency".into());
    }
    let mut session = Session {
        ssh: Command::new("ssh")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .spawn()?,
        injected: false,
    };
    let stdout = session.ssh.stdout.take().ok_or("missing SSH stdout")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if tx.send((Instant::now(), line)).is_err() {
                break;
            }
        }
    });
    if rx.recv_timeout(Duration::from_secs(60))?.1? != "AGENTOS_INPUT_READY" {
        return Err("guest did not announce readiness".into());
    }
    let mut measurements = Vec::new();
    for pair in 0..10 {
        let started = Instant::now();
        session.injected = true;
        if !Command::new("xdotool")
            .args(["key", "F12"])
            .status()?
            .success()
        {
            return Err("native key injection failed".into());
        }
        for sequence in (pair * 2 + 1)..=(pair * 2 + 2) {
            let (received, line) = rx.recv_timeout(Duration::from_secs(3))?;
            if line? != format!("AGENTOS_INPUT_ACK {sequence}") {
                return Err("guest acknowledgment sequence mismatch".into());
            }
            let elapsed = received
                .checked_duration_since(started)
                .ok_or("premature receipt")?;
            let milliseconds = elapsed.as_secs_f64() * 1000.0;
            eprintln!("receipt={sequence} upper_bound_ms={milliseconds:.3}");
            measurements.push(milliseconds);
        }
        // No overlapping keys; leave time for display work between packets.
        std::thread::sleep(Duration::from_millis(100));
    }
    // The trailing quiet-period assertion uses the emulated guest clock.
    // Keep it separate from the host-clock latency measurement above.
    if rx.recv_timeout(Duration::from_secs(30))?.1? != "AGENTOS_GUI_LATENCY_PASS transitions=20" {
        return Err("missing final guest assertion".into());
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = session.ssh.try_wait()? {
            if !status.success() {
                return Err("guest probe exited unsuccessfully".into());
            }
            break;
        }
        if Instant::now() >= deadline {
            return Err("SSH exit deadline expired".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if rx.try_iter().next().is_some() {
        return Err("unexpected trailing guest output".into());
    }
    session.injected = false;
    let mut sorted = measurements.clone();
    sorted.sort_by(f64::total_cmp);
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "schema": "agentos_gui.native_input_latency.v1",
        "scope": "X11 key-pair injection to guest evdev receipt; paired samples include SSH return and host scheduling, not one-way latency",
            "samples_ms": measurements,
            "median_ms": (sorted[9] + sorted[10]) / 2.0,
            "p95_ms": sorted[18],
            "max_ms": sorted[19],
            "guest_assertions_passed": true
        }))?
    );
    Ok(())
}
