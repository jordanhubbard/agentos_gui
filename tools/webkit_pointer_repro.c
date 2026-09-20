#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned draw_count;
static gboolean drawn(GtkWidget *view, cairo_t *context, gpointer data) {
    (void)view; (void)context; (void)data;
    ++draw_count;
    return FALSE;
}

static void snapshot_finished(GObject *source, GAsyncResult *result, gpointer data) {
    GError *error = NULL;
    cairo_surface_t *surface = webkit_web_view_get_snapshot_finish(WEBKIT_WEB_VIEW(source), result, &error);
    if (surface) {
        printf("snapshot_status=%d\n", cairo_surface_write_to_png(surface, data));
        cairo_surface_destroy(surface);
    } else {
        fprintf(stderr, "snapshot_failed=%s\n", error ? error->message : "unknown");
        g_clear_error(&error);
    }
    fflush(stdout);
    g_free(data);
}

static gboolean permission(WebKitWebView *view, WebKitPermissionRequest *request, gpointer data) {
    (void)view; (void)data;
    webkit_permission_request_allow(request);
    return TRUE;
}
static void message(WebKitUserContentManager *manager, WebKitJavascriptResult *result, gpointer data) {
    (void)manager; (void)data;
    gchar *text = jsc_value_to_string(webkit_javascript_result_get_js_value(result));
    puts(text); fflush(stdout);
    GtkWidget *view = g_object_get_data(G_OBJECT(manager), "view");
    static gboolean snapshot_requested = FALSE;
    const char *snapshot_path = getenv("AGENTOS_REPRO_SNAPSHOT");
    if (snapshot_path && !snapshot_requested && strstr(text, "\"locked\":true")) {
        snapshot_requested = TRUE;
        webkit_web_view_get_snapshot(WEBKIT_WEB_VIEW(view), WEBKIT_SNAPSHOT_REGION_VISIBLE,
            WEBKIT_SNAPSHOT_OPTIONS_NONE, NULL, snapshot_finished, g_strdup(snapshot_path));
    }
    g_free(text);
    GdkFrameClock *clock = gtk_widget_get_frame_clock(view);
    if (clock) { printf("gtk_frame=%" G_GINT64_FORMAT " draws=%u\n", gdk_frame_clock_get_frame_counter(clock), draw_count); fflush(stdout); }
    if (getenv("AGENTOS_REPRO_REDRAW"))
        gtk_widget_queue_draw(view);
}
int main(int argc, char **argv) {
    gtk_init(&argc, &argv);
    GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(window), "agentOS WebKit pointer reproduction");
    gtk_window_set_default_size(GTK_WINDOW(window), 800, 500);
    WebKitUserContentManager *manager = webkit_user_content_manager_new();
    webkit_user_content_manager_register_script_message_handler(manager, "diag");
    g_signal_connect(manager, "script-message-received::diag", G_CALLBACK(message), NULL);
    GtkWidget *view = webkit_web_view_new_with_user_content_manager(manager);
    g_signal_connect_after(view, "draw", G_CALLBACK(drawn), NULL);
    g_object_set_data(G_OBJECT(manager), "view", view);
    if (getenv("AGENTOS_REPRO_SOFTWARE"))
        webkit_settings_set_hardware_acceleration_policy(webkit_web_view_get_settings(WEBKIT_WEB_VIEW(view)), WEBKIT_HARDWARE_ACCELERATION_POLICY_NEVER);
    g_signal_connect(view, "permission-request", G_CALLBACK(permission), NULL);
    gtk_container_add(GTK_CONTAINER(window), view);
    g_signal_connect(window, "destroy", G_CALLBACK(gtk_main_quit), NULL);
    webkit_web_view_load_html(WEBKIT_WEB_VIEW(view),
      "<body style='background:#18202b;color:white;font:24px sans-serif'>"
      "<button id='capture'>Capture pointer</button><canvas tabindex='0' id='target' width='600' height='250' style='display:block;background:#384252'></canvas>"
      "<p id='status'>outside</p><p id='frames'></p><script>"
      "const frameText=document.getElementById('frames'),statusText=document.getElementById('status');let ticks=0; function frame(){frameText.textContent='frames '+ ++ticks;requestAnimationFrame(frame)};requestAnimationFrame(frame);"
      "capture.onclick=()=>target.requestPointerLock();"
      "document.addEventListener('keydown',e=>{if(e.key==='Escape')document.exitPointerLock();});"
      "document.addEventListener('pointerlockchange',()=>{statusText.textContent=document.pointerLockElement===target?'captured':'outside';if(document.pointerLockElement===target)target.focus();});"
      "setInterval(()=>window.webkit.messageHandlers.diag.postMessage(JSON.stringify({locked:document.pointerLockElement===target,hidden:document.hidden,ticks,status:document.getElementById('status').textContent})),1000);"
      "</script>", "file:///tmp/");
    gtk_widget_show_all(window);
    gtk_main();
    return 0;
}
