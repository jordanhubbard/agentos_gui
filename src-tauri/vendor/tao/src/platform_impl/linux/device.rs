use std::{
  io::Write,
  os::fd::AsRawFd,
  os::raw::{c_int, c_uchar},
  os::unix::net::UnixStream,
  ptr,
  thread::JoinHandle,
};

use gtk::glib;
use x11_dl::{xinput2, xlib};

use crate::event::{DeviceEvent, ElementState, RawKeyEvent};

use super::keycode_from_scancode;

/// Own the reader until it has stopped using Xlib and its extensions.
pub struct DeviceEventThread {
  wake: UnixStream,
  thread: Option<JoinHandle<()>>,
}

impl Drop for DeviceEventThread {
  fn drop(&mut self) {
    if let Some(thread) = self.thread.take() {
      let _ = self.wake.write_all(&[1]);
      if thread.join().is_err() {
        log::warn!("X11 device event thread panicked during shutdown");
      }
    }
  }
}

// A separate descriptor wakes an idle reader without sending an X event or
// closing its display from another thread. Pending X events never bypass stop.
fn wait_for_input(display_fd: c_int, stop_fd: c_int, pending: bool) -> bool {
  let mut fds = [
    libc::pollfd {
      fd: stop_fd,
      events: libc::POLLIN,
      revents: 0,
    },
    libc::pollfd {
      fd: display_fd,
      events: libc::POLLIN,
      revents: 0,
    },
  ];
  loop {
    let result = unsafe { libc::poll(fds.as_mut_ptr(), 2, if pending { 0 } else { -1 }) };
    if result < 0 {
      if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
        continue;
      }
      return false;
    }
    return fds[0].revents == 0
      && fds[1].revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) == 0;
  }
}

/// Spawn Device event thread. Only works on x11 since wayland doesn't have such global events.
pub fn spawn(device_tx: glib::Sender<DeviceEvent>) -> DeviceEventThread {
  let (wake, stop) = UnixStream::pair().expect("failed to create X11 device shutdown channel");
  let thread = std::thread::spawn(move || unsafe {
    let xlib = xlib::Xlib::open().unwrap();
    let xinput2 = xinput2::XInput2::open().unwrap();
    let display = (xlib.XOpenDisplay)(ptr::null());
    if display.is_null() {
      log::warn!("X11 device event display could not be opened");
      return;
    }
    let root = (xlib.XDefaultRootWindow)(display);
    // TODO Add more device event mask
    let mask = xinput2::XI_RawKeyPressMask | xinput2::XI_RawKeyReleaseMask;
    let mut event_mask = xinput2::XIEventMask {
      deviceid: xinput2::XIAllMasterDevices,
      mask: &mask as *const _ as *mut c_uchar,
      mask_len: std::mem::size_of_val(&mask) as c_int,
    };
    (xinput2.XISelectEvents)(display, root, &mut event_mask as *mut _, 1);

    let mut event: xlib::XEvent = std::mem::zeroed();
    loop {
      let pending = (xlib.XPending)(display) > 0;
      if !wait_for_input((xlib.XConnectionNumber)(display), stop.as_raw_fd(), pending) {
        break;
      }
      if (xlib.XPending)(display) == 0 {
        continue;
      }
      (xlib.XNextEvent)(display, &mut event);

      // XFilterEvent tells us when an event has been discarded by the input method.
      // Specifically, this involves all of the KeyPress events in compose/pre-edit sequences,
      // along with an extra copy of the KeyRelease events. This also prevents backspace and
      // arrow keys from being detected twice.
      if xlib::True == {
        (xlib.XFilterEvent)(&mut event, {
          let xev: &xlib::XAnyEvent = event.as_ref();
          xev.window
        })
      } {
        continue;
      }

      let event_type = event.get_type();
      if event_type == xlib::GenericEvent {
        let mut xev = event.generic_event_cookie;
        if (xlib.XGetEventData)(display, &mut xev) == xlib::True {
          let mut receiver_closed = false;
          match xev.evtype {
            xinput2::XI_RawKeyPress | xinput2::XI_RawKeyRelease => {
              let xev: &xinput2::XIRawEvent = &*(xev.data as *const _);
              let physical_key = keycode_from_scancode(xev.detail as u32);
              let state = match xev.evtype {
                xinput2::XI_RawKeyPress => ElementState::Pressed,
                xinput2::XI_RawKeyRelease => ElementState::Released,
                _ => unreachable!(),
              };

              let event = RawKeyEvent {
                physical_key,
                state,
              };

              if let Err(e) = device_tx.send(DeviceEvent::Key(event)) {
                log::info!("Failed to send device event {} since receiver is closed. Closing x11 thread along with it", e);
                receiver_closed = true;
              }
            }
            _ => {}
          }
          (xlib.XFreeEventData)(display, &mut xev);
          if receiver_closed {
            break;
          }
        }
      }
    }
    (xlib.XCloseDisplay)(display);
  });
  DeviceEventThread {
    wake,
    thread: Some(thread),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
  };

  #[test]
  fn stop_wakes_idle_reader_and_drop_joins_it() {
    let (_display_peer, display) = UnixStream::pair().unwrap();
    let (wake, stop) = UnixStream::pair().unwrap();
    let finished = Arc::new(AtomicBool::new(false));
    let worker_finished = finished.clone();
    let thread = std::thread::spawn(move || {
      assert!(!wait_for_input(
        display.as_raw_fd(),
        stop.as_raw_fd(),
        false
      ));
      worker_finished.store(true, Ordering::Release);
    });
    drop(DeviceEventThread {
      wake,
      thread: Some(thread),
    });
    assert!(finished.load(Ordering::Acquire));
  }

  #[test]
  fn stop_takes_priority_over_pending_events() {
    let (mut display_peer, display) = UnixStream::pair().unwrap();
    let (mut wake, stop) = UnixStream::pair().unwrap();
    assert!(wait_for_input(display.as_raw_fd(), stop.as_raw_fd(), true));
    display_peer.write_all(&[1]).unwrap();
    assert!(wait_for_input(display.as_raw_fd(), stop.as_raw_fd(), false));
    wake.write_all(&[1]).unwrap();
    assert!(!wait_for_input(display.as_raw_fd(), stop.as_raw_fd(), true));
  }
}
