pub mod cc_ipc;
mod commands;

pub use commands::AppState;

pub fn run() {
    configure_webkit_renderer();
    tauri::Builder::default()
        .manage(commands::AppState::default())
        .setup(|app| {
            #[cfg(target_os = "linux")]
            install_presentation_flush(app)?;
            Ok(())
        })
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
            commands::cc_frame_capture,
            commands::cc_frame_read,
            commands::cc_frame_release,
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

#[cfg(target_os = "linux")]
fn install_presentation_flush(app: &tauri::App) -> tauri::Result<()> {
    use gtk::prelude::*;
    use tauri::Manager;

    if let Some(window) = app.get_webview_window("main") {
        window.with_webview(|webview| {
            // Run after WebKit's draw handler. Cairo's shared-pixmap fallback
            // can retain pending pixels across pointer capture; completing
            // its surface writes here keeps native presentation advancing.
            // Keep MIT-SHM and the system renderer enabled.
            webview.inner().connect_local("draw", true, |values| {
                let context = values[1]
                    .get::<gtk::cairo::Context>()
                    .expect("GTK draw signal supplies a Cairo context");
                context.target().flush();
                Some(false.to_value())
            });
        })?;
    }
    Ok(())
}

fn configure_webkit_renderer() {
    #[cfg(target_os = "linux")]
    {
        // WebKit's DMA-BUF path can fail to allocate GBM buffers on NVIDIA,
        // leaving a blank window despite a successful application startup.
        // Choose the working renderer path before WebKit creates threads, and
        // preserve an explicit operator setting (including "0").
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() {
            return;
        }
        let nvidia = std::fs::read_dir("/sys/class/drm")
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("renderD"))
            .any(|entry| {
                std::fs::read_to_string(entry.path().join("device/vendor"))
                    .is_ok_and(|vendor| vendor.trim().eq_ignore_ascii_case("0x10de"))
            });
        if nvidia {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            eprintln!("agentOS GUI: using WebKit without DMA-BUF on NVIDIA; WEBKIT_DISABLE_DMABUF_RENDERER overrides this default");
        }
    }
}
