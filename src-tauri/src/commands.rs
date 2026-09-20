use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::State;

use crate::cc_ipc::{
    CcClient, DesktopInputEvent, DeviceInfo, DeviceStatusInfo, FaultInjectResult, FrameInfo,
    GuestCreateRequest, GuestCreateResult, GuestInfo, GuestLifecycleResult, GuestStatus,
    InputBatchAck, InputEvent, PoecatStatus, SessionInfo, SessionRecvResult, SessionSendResult,
    SessionStatus, SnapResult, TraceDumpResult, TraceStatus, TrafficEvent, CC_DEV_TYPE_COUNT,
};

type ClientCell = Arc<Mutex<Option<CcClient>>>;
type SockPathCell = Arc<Mutex<String>>;

pub struct AppState {
    pub client: ClientCell,
    pub sock_path: SockPathCell,
}

impl Default for AppState {
    fn default() -> Self {
        AppState {
            client: Arc::new(Mutex::new(None)),
            sock_path: Arc::new(Mutex::new(default_sock_path())),
        }
    }
}

fn default_sock_path() -> String {
    if let Ok(path) = std::env::var("CC_PD_SOCK") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return trimmed.into();
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        if let Some(path) = sibling_agentos_sock(&cwd) {
            return path;
        }

        let local = cwd.join("build/cc_pd.sock");
        if local.exists() {
            return local.to_string_lossy().into_owned();
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(path) = sibling_agentos_sock(&exe) {
            return path;
        }
    }

    if let Some(home) = std::env::var_os("HOME") {
        let home_src = Path::new(&home).join("Src/agentos/build/cc_pd.sock");
        if home_src.exists() {
            return home_src.to_string_lossy().into_owned();
        }
    }

    "build/cc_pd.sock".into()
}

fn sibling_agentos_sock(path: &Path) -> Option<String> {
    for ancestor in path.ancestors() {
        if ancestor
            .file_name()
            .is_some_and(|name| name == "agentos_gui")
        {
            let repo_parent = ancestor.parent()?;
            let sock = repo_parent.join("agentos/build/cc_pd.sock");
            return Some(sock.to_string_lossy().into_owned());
        }
    }
    None
}

fn env_flag_enabled(name: &str) -> bool {
    match std::env::var(name) {
        Ok(value) => {
            let value = value.trim().to_ascii_lowercase();
            !value.is_empty() && value != "0" && value != "false" && value != "no"
        }
        Err(_) => false,
    }
}

// ── Connection ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn cc_connect(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let client = state.client.clone();
    let sock_path = state.sock_path.clone();

    run_blocking(move || {
        let mut guard = client
            .lock()
            .map_err(|_| "client lock poisoned".to_string())?;
        if let Some(c) = guard.as_mut() {
            let _ = c.disconnect();
        }
        *guard = None;

        let new_client = CcClient::connect(&path).map_err(|e| e.to_string())?;
        *sock_path
            .lock()
            .map_err(|_| "socket path lock poisoned".to_string())? = path;
        *guard = Some(new_client);
        Ok("connected".into())
    })
    .await
}

#[tauri::command]
pub async fn cc_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    let client = state.client.clone();

    run_blocking(move || {
        let mut guard = client
            .lock()
            .map_err(|_| "client lock poisoned".to_string())?;
        if let Some(c) = guard.as_mut() {
            let _ = c.disconnect();
        }
        *guard = None;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn cc_is_connected(state: State<'_, AppState>) -> Result<bool, String> {
    let client = state.client.clone();
    run_blocking(move || {
        Ok(client
            .lock()
            .map_err(|_| "client lock poisoned".to_string())?
            .is_some())
    })
    .await
}

// ── Session management ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn cc_list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionInfo>, String> {
    with_client(state.client.clone(), |c: &mut CcClient| {
        c.list_sessions().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn cc_session_status(
    session_id: Option<u32>,
    state: State<'_, AppState>,
) -> Result<SessionStatus, String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.session_status(session_id).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn cc_session_send(
    cmd_type: u32,
    command: String,
    state: State<'_, AppState>,
) -> Result<SessionSendResult, String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.session_send(cmd_type, &command)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn cc_session_recv(
    max: u32,
    state: State<'_, AppState>,
) -> Result<SessionRecvResult, String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.session_recv(max).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn cc_traffic_events(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<TrafficEvent>, String> {
    let client = state.client.clone();
    run_blocking(move || {
        let guard = client
            .lock()
            .map_err(|_| "client lock poisoned".to_string())?;
        let c = guard.as_ref().ok_or_else(|| "not connected".to_string())?;
        Ok(c.traffic_events(limit))
    })
    .await
}

// ── Guests ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn cc_frame_capture(
    handle: u32,
    state: State<'_, AppState>,
) -> Result<FrameInfo, String> {
    with_client(state.client.clone(), move |c| {
        c.frame_capture(handle).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn cc_frame_read(
    token: String,
    offset: u32,
    length: u32,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    let bytes = with_client(state.client.clone(), move |c| {
        c.frame_read_batch(&token, offset, length)
            .map_err(|e| e.to_string())
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn cc_frame_release(token: String, state: State<'_, AppState>) -> Result<(), String> {
    with_client(state.client.clone(), move |c| {
        c.frame_release(&token).map_err(|e| e.to_string())
    })
    .await
}

/// One atomic virtio-input batch. Callers must await its acknowledgment before
/// submitting the next batch; only status 3 (zero accepted) permits a retry.
#[tauri::command]
pub async fn cc_input_submit(
    handle: u32,
    device: u32,
    events: Vec<DesktopInputEvent>,
    state: State<'_, AppState>,
) -> Result<InputBatchAck, String> {
    // Diagnostic timing is opt-in and contains no key/button values. Queue
    // time includes blocking-worker scheduling and waiting for frame/status
    // calls to release the shared socket; acknowledgment is not evdev delivery.
    let timing = env_flag_enabled("AGENTOS_GUI_INPUT_TIMING");
    let started = std::time::Instant::now();
    with_client(state.client.clone(), move |c: &mut CcClient| {
        let acquired = std::time::Instant::now();
        let result = c.input_submit(handle, device, &events).map_err(|e| e.to_string());
        if timing {
            eprintln!("AGENTOS_INPUT_TIMING device={} events={} queue_us={} request_us={} ok={}",
                device, events.len(), acquired.duration_since(started).as_micros(),
                acquired.elapsed().as_micros(), result.is_ok());
        }
        result
    })
    .await
}

#[tauri::command]
pub async fn cc_list_guests(state: State<'_, AppState>) -> Result<Vec<GuestInfo>, String> {
    with_client(state.client.clone(), |c: &mut CcClient| {
        c.list_guests().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn cc_guest_status(
    handle: u32,
    state: State<'_, AppState>,
) -> Result<GuestStatus, String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.guest_status(handle).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn cc_snapshot(handle: u32, state: State<'_, AppState>) -> Result<SnapResult, String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.snapshot(handle).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn cc_restore(
    handle: u32,
    snap_lo: u32,
    snap_hi: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.restore(handle, snap_lo, snap_hi)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn cc_create_guest(
    request: GuestCreateRequest,
    state: State<'_, AppState>,
) -> Result<GuestCreateResult, String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.create_guest(&request).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn cc_suspend_guest(
    handle: u32,
    state: State<'_, AppState>,
) -> Result<GuestLifecycleResult, String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.suspend_guest(handle).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn cc_resume_guest(
    handle: u32,
    state: State<'_, AppState>,
) -> Result<GuestLifecycleResult, String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.resume_guest(handle).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn cc_destroy_guest(
    handle: u32,
    reason: u32,
    state: State<'_, AppState>,
) -> Result<GuestLifecycleResult, String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.destroy_guest(handle, reason).map_err(|e| e.to_string())
    })
    .await
}

// ── Devices ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn cc_list_devices(
    dev_type: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<DeviceInfo>, String> {
    let client = state.client.clone();

    run_blocking(move || {
        let mut guard = client
            .lock()
            .map_err(|_| "client lock poisoned".to_string())?;
        let c = guard.as_mut().ok_or_else(|| "not connected".to_string())?;

        match dev_type {
            Some(t) => c.list_devices(t).map_err(|e| e.to_string()),
            None => {
                let mut all = Vec::new();
                for t in 0..CC_DEV_TYPE_COUNT {
                    let mut devs = c.list_devices(t).map_err(|e| e.to_string())?;
                    all.append(&mut devs);
                }
                Ok(all)
            }
        }
    })
    .await
}

// ── Agents (polecats) ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn cc_list_polecats(state: State<'_, AppState>) -> Result<PoecatStatus, String> {
    with_client(state.client.clone(), |c: &mut CcClient| {
        c.list_polecats().map_err(|e| e.to_string())
    })
    .await
}

// ── Logs ──────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn cc_log_stream(
    slot: u32,
    pd_id: u32,
    by_handle: Option<bool>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        if by_handle.unwrap_or(false) {
            c.guest_console(slot).map_err(|e| e.to_string())
        } else {
            c.log_stream(slot, pd_id).map_err(|e| e.to_string())
        }
    })
    .await
}

// ── Input ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn cc_send_input(
    handle: u32,
    event: InputEvent,
    state: State<'_, AppState>,
) -> Result<(), String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.send_input(handle, &event).map_err(|e| e.to_string())
    })
    .await
}

// ── Device status + framebuffer ───────────────────────────────────────────────

#[tauri::command]
pub async fn cc_device_status(
    dev_type: u32,
    dev_handle: u32,
    state: State<'_, AppState>,
) -> Result<DeviceStatusInfo, String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.device_status(dev_type, dev_handle)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn cc_attach_framebuffer(
    guest_handle: u32,
    fb_handle: u32,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.attach_framebuffer(guest_handle, fb_handle)
            .map_err(|e| e.to_string())
    })
    .await
}

// ── Fault injection ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn cc_fault_inject(
    slot_id: u32,
    fault_kind: u32,
    flags: u32,
    state: State<'_, AppState>,
) -> Result<FaultInjectResult, String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.fault_inject(slot_id, fault_kind, flags)
            .map_err(|e| e.to_string())
    })
    .await
}

// ── Trace relay ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn cc_trace_start(flags: u32, state: State<'_, AppState>) -> Result<TraceStatus, String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.trace_start(flags).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn cc_trace_stop(state: State<'_, AppState>) -> Result<TraceStatus, String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.trace_stop().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn cc_trace_query(state: State<'_, AppState>) -> Result<TraceStatus, String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.trace_query().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn cc_trace_dump(
    max_events: u32,
    state: State<'_, AppState>,
) -> Result<TraceDumpResult, String> {
    with_client(state.client.clone(), move |c: &mut CcClient| {
        c.trace_dump(max_events).map_err(|e| e.to_string())
    })
    .await
}

// ── Config ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn cc_get_sock_path(state: State<'_, AppState>) -> Result<String, String> {
    let sock_path = state.sock_path.clone();
    run_blocking(move || {
        Ok(sock_path
            .lock()
            .map_err(|_| "socket path lock poisoned".to_string())?
            .clone())
    })
    .await
}

#[tauri::command]
pub fn cc_should_autoconnect() -> bool {
    env_flag_enabled("AGENTOS_GUI_AUTOCONNECT")
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async fn with_client<F, T>(client: ClientCell, f: F) -> Result<T, String>
where
    F: FnOnce(&mut CcClient) -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    run_blocking(move || {
        let mut guard = client
            .lock()
            .map_err(|_| "client lock poisoned".to_string())?;
        let c = guard.as_mut().ok_or_else(|| "not connected".to_string())?;
        f(c)
    })
    .await
}

async fn run_blocking<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("blocking command failed: {e}"))?
}
