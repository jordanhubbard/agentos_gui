use std::sync::Mutex;
use tauri::State;

use crate::cc_ipc::{
    CcClient, DeviceInfo, DeviceStatusInfo, GuestInfo, GuestStatus, InputEvent,
    PoecatStatus, SnapResult, CC_DEV_TYPE_COUNT,
};

pub struct AppState {
    pub client: Mutex<Option<CcClient>>,
    pub sock_path: Mutex<String>,
}

impl Default for AppState {
    fn default() -> Self {
        AppState {
            client: Mutex::new(None),
            sock_path: Mutex::new("build/cc_pd.sock".into()),
        }
    }
}

// ── Connection ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn cc_connect(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let mut guard = state.client.lock().unwrap();
    if guard.is_some() {
        if let Some(c) = guard.as_mut() {
            let _ = c.disconnect();
        }
        *guard = None;
    }
    match CcClient::connect(&path) {
        Ok(client) => {
            *state.sock_path.lock().unwrap() = path;
            *guard = Some(client);
            Ok("connected".into())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn cc_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.client.lock().unwrap();
    if let Some(c) = guard.as_mut() {
        let _ = c.disconnect();
    }
    *guard = None;
    Ok(())
}

#[tauri::command]
pub fn cc_is_connected(state: State<'_, AppState>) -> bool {
    state.client.lock().unwrap().is_some()
}

// ── Guests ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn cc_list_guests(state: State<'_, AppState>) -> Result<Vec<GuestInfo>, String> {
    with_client(&state, |c: &mut CcClient| c.list_guests().map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn cc_guest_status(handle: u32, state: State<'_, AppState>) -> Result<GuestStatus, String> {
    with_client(&state, |c: &mut CcClient| c.guest_status(handle).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn cc_snapshot(handle: u32, state: State<'_, AppState>) -> Result<SnapResult, String> {
    with_client(&state, |c: &mut CcClient| c.snapshot(handle).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn cc_restore(
    handle: u32,
    snap_lo: u32,
    snap_hi: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    with_client(&state, |c: &mut CcClient| {
        c.restore(handle, snap_lo, snap_hi).map_err(|e| e.to_string())
    })
}

// ── Devices ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn cc_list_devices(
    dev_type: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<DeviceInfo>, String> {
    match dev_type {
        Some(t) => with_client(&state, |c: &mut CcClient| {
            c.list_devices(t).map_err(|e| e.to_string())
        }),
        None => {
            let mut all = Vec::new();
            for t in 0..CC_DEV_TYPE_COUNT {
                let mut devs = with_client(&state, |c: &mut CcClient| {
                    c.list_devices(t).map_err(|e| e.to_string())
                })?;
                all.append(&mut devs);
            }
            Ok(all)
        }
    }
}

// ── Agents (polecats) ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn cc_list_polecats(state: State<'_, AppState>) -> Result<PoecatStatus, String> {
    with_client(&state, |c: &mut CcClient| c.list_polecats().map_err(|e| e.to_string()))
}

// ── Logs ──────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn cc_log_stream(
    slot: u32,
    pd_id: u32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    with_client(&state, |c: &mut CcClient| {
        c.log_stream(slot, pd_id).map_err(|e| e.to_string())
    })
}

// ── Input ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn cc_send_input(
    handle: u32,
    event: InputEvent,
    state: State<'_, AppState>,
) -> Result<(), String> {
    with_client(&state, |c: &mut CcClient| {
        c.send_input(handle, &event).map_err(|e| e.to_string())
    })
}

// ── Device status + framebuffer ───────────────────────────────────────────────

#[tauri::command]
pub fn cc_device_status(
    dev_type: u32,
    dev_handle: u32,
    state: State<'_, AppState>,
) -> Result<DeviceStatusInfo, String> {
    with_client(&state, |c: &mut CcClient| {
        c.device_status(dev_type, dev_handle).map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn cc_attach_framebuffer(
    guest_handle: u32,
    fb_handle: u32,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    with_client(&state, |c: &mut CcClient| {
        c.attach_framebuffer(guest_handle, fb_handle).map_err(|e| e.to_string())
    })
}

// ── Config ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn cc_get_sock_path(state: State<'_, AppState>) -> String {
    state.sock_path.lock().unwrap().clone()
}

// ── Helper ────────────────────────────────────────────────────────────────────

fn with_client<F, T>(state: &State<'_, AppState>, f: F) -> Result<T, String>
where
    F: FnOnce(&mut CcClient) -> Result<T, String>,
{
    let mut guard = state.client.lock().unwrap();
    match guard.as_mut() {
        Some(c) => f(c),
        None => Err("not connected".into()),
    }
}
