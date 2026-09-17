pub mod cc_ipc;
mod commands;

pub use commands::AppState;

pub fn run() {
    tauri::Builder::default()
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::cc_connect,
            commands::cc_disconnect,
            commands::cc_is_connected,
            commands::cc_list_sessions,
            commands::cc_session_status,
            commands::cc_session_send,
            commands::cc_session_recv,
            commands::cc_traffic_events,
            commands::cc_list_guests,
            commands::cc_guest_status,
            commands::cc_snapshot,
            commands::cc_restore,
            commands::cc_create_guest,
            commands::cc_suspend_guest,
            commands::cc_resume_guest,
            commands::cc_destroy_guest,
            commands::cc_list_devices,
            commands::cc_list_polecats,
            commands::cc_log_stream,
            commands::cc_send_input,
            commands::cc_input_submit,
            commands::cc_get_sock_path,
            commands::cc_should_autoconnect,
            commands::cc_device_status,
            commands::cc_attach_framebuffer,
            commands::cc_fault_inject,
            commands::cc_trace_start,
            commands::cc_trace_stop,
            commands::cc_trace_query,
            commands::cc_trace_dump,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
