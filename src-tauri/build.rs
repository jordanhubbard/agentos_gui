fn main() {
    // Generate per-command ACL permissions (`allow-<command>` / `deny-<command>`)
    // for every command this crate registers via `tauri::generate_handler!` in
    // `src/lib.rs`, so that `capabilities/default.json` can grant access to
    // exactly the commands the UI uses instead of relying on an unscoped
    // `core:default`.
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "cc_connect",
            "cc_disconnect",
            "cc_is_connected",
            "cc_list_sessions",
            "cc_session_status",
            "cc_session_send",
            "cc_session_recv",
            "cc_traffic_events",
            "cc_list_guests",
            "cc_guest_status",
            "cc_snapshot",
            "cc_restore",
            "cc_create_guest",
            "cc_suspend_guest",
            "cc_resume_guest",
            "cc_destroy_guest",
            "cc_list_devices",
            "cc_list_polecats",
            "cc_log_stream",
            "cc_send_input",
            "cc_get_sock_path",
            "cc_should_autoconnect",
            "cc_allowed_sock_paths",
            "cc_device_status",
            "cc_attach_framebuffer",
            "cc_fault_inject",
            "cc_trace_start",
            "cc_trace_stop",
            "cc_trace_query",
            "cc_trace_dump",
        ]),
    );

    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
