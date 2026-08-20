// SPDX-License-Identifier: AGPL-3.0-or-later

//! X11 screen capture backend.
//!
//! Echowire addition. The portal/PipeWire backend in `pipewire_stream.rs` is the only Linux
//! capture path upstream ships, and it requires an xdg-desktop-portal ScreenCast interface. That
//! interface is Wayland-oriented and simply does not exist on an X11 session (the GTK portal
//! backend does not implement ScreenCast there), so screen sharing was impossible for X11 users
//! even though the old Electron `desktopCapturer` path had always worked for them.
//!
//! This backend restores that capability by capturing straight from the X server with MIT-SHM,
//! then reusing the existing `bgra_to_nv12` conversion and frame buffer pool so frames reach the
//! rest of the pipeline in exactly the same shape as PipeWire frames.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use x11rb::connection::Connection;
use x11rb::protocol::randr::ConnectionExt as _;
use x11rb::protocol::shm::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat};
use x11rb::rust_connection::RustConnection;

use crate::frame_buffer_pool::LinuxFrameBufferPool;
use crate::nv12_packing::{Nv12Layout, bgra_to_nv12};
use crate::pipewire_stream::{
    BridgeError, FrameCallback, LifecycleCallback, PoolExhaustionCallback, VideoFrame,
    VideoFrameData,
};

pub const BACKEND_X11: &str = "linux-x11";

const DEFAULT_FPS: u32 = 30;
const MAX_FPS: u32 = 144;

/// A capturable X11 monitor, as reported by RandR.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct X11Monitor {
    pub id: u32,
    pub name: String,
    pub x: i16,
    pub y: i16,
    pub width: u16,
    pub height: u16,
}

fn connect() -> Result<(RustConnection, usize), BridgeError> {
    x11rb::connect(None).map_err(|_| BridgeError::X11Unavailable)
}

/// True when an X11 display is reachable and the SHM extension is usable.
///
/// SHM is required rather than optional: without it every frame would cross the wire as a
/// protocol reply, which is far too slow for screen sharing.
pub fn x11_available() -> bool {
    let Ok((conn, _)) = connect() else {
        return false;
    };
    conn.shm_query_version()
        .ok()
        .and_then(|c| c.reply().ok())
        .is_some()
}

/// Enumerate monitors via RandR, falling back to the whole root window when RandR is absent.
pub fn list_monitors() -> Result<Vec<X11Monitor>, BridgeError> {
    let (conn, screen_num) = connect()?;
    let root = conn
        .setup()
        .roots
        .get(screen_num)
        .ok_or(BridgeError::X11Unavailable)?
        .root;

    if let Ok(cookie) = conn.randr_get_monitors(root, true)
        && let Ok(reply) = cookie.reply()
    {
        let mut out = Vec::new();
        for (index, monitor) in reply.monitors.iter().enumerate() {
            // The app's picker maps native sources onto Electron desktopCapturer cards by bare
            // numeric id (`screen:<token>:0`), and Electron reports the RandR output XID as that
            // token. Identify monitors the same way; an ordinal here can never match, which is
            // exactly why the first cut of this backend was never selected by the picker.
            let output_id = monitor
                .outputs
                .first()
                .copied()
                .unwrap_or(index as u32 + 1);
            let name = conn
                .get_atom_name(monitor.name)
                .ok()
                .and_then(|c| c.reply().ok())
                .map(|r| String::from_utf8_lossy(&r.name).to_string())
                .unwrap_or_else(|| format!("Display {}", index + 1));
            out.push(X11Monitor {
                id: output_id,
                name,
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height,
            });
        }
        if !out.is_empty() {
            return Ok(out);
        }
    }

    let screen = conn
        .setup()
        .roots
        .get(screen_num)
        .ok_or(BridgeError::X11Unavailable)?;
    Ok(vec![X11Monitor {
        id: 1,
        name: "Display 1".to_string(),
        x: 0,
        y: 0,
        width: screen.width_in_pixels,
        height: screen.height_in_pixels,
    }])
}

/// A POSIX shared memory segment attached to both this process and the X server.
struct ShmBuffer {
    shmid: i32,
    addr: *mut libc::c_void,
    len: usize,
}

// The raw pointer is only ever touched by the capture thread that owns the ShmBuffer.
unsafe impl Send for ShmBuffer {}

impl ShmBuffer {
    fn new(len: usize) -> Result<Self, BridgeError> {
        // SAFETY: standard System V shared memory allocation; the returned id is validated below.
        let shmid = unsafe { libc::shmget(libc::IPC_PRIVATE, len, libc::IPC_CREAT | 0o600) };
        if shmid < 0 {
            return Err(BridgeError::X11Unavailable);
        }
        // SAFETY: shmid was just created with the requested length.
        let addr = unsafe { libc::shmat(shmid, std::ptr::null(), 0) };
        if addr == usize::MAX as *mut libc::c_void {
            // SAFETY: removing a segment we created and never attached.
            unsafe { libc::shmctl(shmid, libc::IPC_RMID, std::ptr::null_mut()) };
            return Err(BridgeError::X11Unavailable);
        }
        Ok(Self { shmid, addr, len })
    }

    fn as_slice(&self) -> &[u8] {
        // SAFETY: addr is attached and covers len bytes for the lifetime of self.
        unsafe { std::slice::from_raw_parts(self.addr as *const u8, self.len) }
    }
}

impl Drop for ShmBuffer {
    fn drop(&mut self) {
        // SAFETY: detaching and removing the segment this struct owns.
        unsafe {
            libc::shmdt(self.addr);
            libc::shmctl(self.shmid, libc::IPC_RMID, std::ptr::null_mut());
        }
    }
}

pub struct X11VideoStream {
    running: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
    frames_dropped_pool_exhausted: Arc<AtomicU64>,
}

impl X11VideoStream {
    pub fn open(
        monitor: X11Monitor,
        target_fps: Option<u32>,
        on_frame: FrameCallback,
        on_lifecycle: LifecycleCallback,
        pool: Arc<LinuxFrameBufferPool>,
        on_pool_exhausted: Option<PoolExhaustionCallback>,
    ) -> Result<Self, BridgeError> {
        // NV12 needs even dimensions; trim rather than fail so odd-sized monitors still work.
        let width = u32::from(monitor.width) & !1;
        let height = u32::from(monitor.height) & !1;
        if width == 0 || height == 0 {
            return Err(BridgeError::X11Unavailable);
        }

        let fps = target_fps.unwrap_or(DEFAULT_FPS).clamp(1, MAX_FPS);
        let interval = Duration::from_nanos(1_000_000_000 / u64::from(fps));

        let running = Arc::new(AtomicBool::new(true));
        let frames_dropped_pool_exhausted = Arc::new(AtomicU64::new(0));

        let thread_running = Arc::clone(&running);
        let thread_dropped = Arc::clone(&frames_dropped_pool_exhausted);
        let handle = std::thread::Builder::new()
            .name("fluxer-x11-capture".to_string())
            .spawn(move || {
                let result = capture_loop(
                    monitor,
                    width,
                    height,
                    interval,
                    &thread_running,
                    &on_frame,
                    &pool,
                    on_pool_exhausted.as_ref(),
                    &thread_dropped,
                );
                match result {
                    Ok(()) => on_lifecycle("stopped", ""),
                    Err(err) => on_lifecycle("error", &err.to_string()),
                }
            })
            .map_err(|_| BridgeError::X11Unavailable)?;

        Ok(Self {
            running,
            thread: Mutex::new(Some(handle)),
            frames_dropped_pool_exhausted,
        })
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = self.thread.lock()
            && let Some(handle) = guard.take()
        {
            let _ = handle.join();
        }
    }

    pub fn frames_dropped_pool_exhausted(&self) -> u64 {
        self.frames_dropped_pool_exhausted.load(Ordering::Relaxed)
    }
}

impl Drop for X11VideoStream {
    fn drop(&mut self) {
        self.stop();
    }
}

#[allow(clippy::too_many_arguments)]
fn capture_loop(
    monitor: X11Monitor,
    width: u32,
    height: u32,
    interval: Duration,
    running: &AtomicBool,
    on_frame: &FrameCallback,
    pool: &Arc<LinuxFrameBufferPool>,
    on_pool_exhausted: Option<&PoolExhaustionCallback>,
    frames_dropped_pool_exhausted: &AtomicU64,
) -> Result<(), BridgeError> {
    let (conn, screen_num) = connect()?;
    let root = conn
        .setup()
        .roots
        .get(screen_num)
        .ok_or(BridgeError::X11Unavailable)?
        .root;

    conn.shm_query_version()
        .map_err(|_| BridgeError::X11Unavailable)?
        .reply()
        .map_err(|_| BridgeError::X11Unavailable)?;

    let bgra_stride = width * 4;
    let shm = ShmBuffer::new((bgra_stride * height) as usize)?;

    let seg: shm::Seg = conn.generate_id().map_err(|_| BridgeError::X11Unavailable)?;
    conn.shm_attach(seg, shm.shmid as u32, false)
        .map_err(|_| BridgeError::X11Unavailable)?
        .check()
        .map_err(|_| BridgeError::X11Unavailable)?;

    let layout = Nv12Layout {
        width,
        height,
        stride_y: width,
        stride_uv: width,
    };
    let packed = layout.packed_size().ok_or(BridgeError::X11Unavailable)?;

    while running.load(Ordering::Relaxed) {
        let started = Instant::now();

        let grabbed = conn
            .shm_get_image(
                root,
                monitor.x,
                monitor.y,
                width as u16,
                height as u16,
                u32::MAX,
                ImageFormat::Z_PIXMAP.into(),
                seg,
                0,
            )
            .ok()
            .and_then(|cookie| cookie.reply().ok())
            .is_some();

        if grabbed {
            match pool.try_acquire() {
                Some(mut buffer) => {
                    let converted = {
                        let dst = buffer.buffer_mut();
                        dst.len() >= packed
                            && bgra_to_nv12(layout, shm.as_slice(), bgra_stride, dst, false)
                    };
                    if converted {
                        buffer.set_len(packed);
                        let timestamp_us = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .map(|d| d.as_micros() as i64)
                            .unwrap_or(0);
                        on_frame(VideoFrame {
                            width,
                            height,
                            stride_y: layout.stride_y,
                            stride_uv: layout.stride_uv,
                            timestamp_us,
                            data: VideoFrameData::Pooled(buffer),
                            dmabuf: None,
                        });
                    }
                }
                None => {
                    let dropped = frames_dropped_pool_exhausted.fetch_add(1, Ordering::Relaxed) + 1;
                    if let Some(cb) = on_pool_exhausted {
                        cb(dropped);
                    }
                }
            }
        }

        if let Some(remaining) = interval.checked_sub(started.elapsed()) {
            std::thread::sleep(remaining);
        }
    }

    let _ = conn.shm_detach(seg);
    Ok(())
}
