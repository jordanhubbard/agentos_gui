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
            commands::cc_list_guests,
            commands::cc_guest_status,
            commands::cc_snapshot,
            commands::cc_restore,
            commands::cc_create_guest,
            commands::cc_list_devices,
            commands::cc_list_polecats,
            commands::cc_log_stream,
            commands::cc_send_input,
            commands::cc_get_sock_path,
            commands::cc_should_autoconnect,
            commands::cc_device_status,
            commands::cc_attach_framebuffer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
