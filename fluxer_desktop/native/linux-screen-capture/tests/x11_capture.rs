// SPDX-License-Identifier: AGPL-3.0-or-later
//! Echowire: exercises the X11 capture backend against the live display.
//! Skips (passes) when no X11 display is reachable, so CI on headless boxes stays green.

#![cfg(target_os = "linux")]

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use fluxer_linux_screen_capture::frame_buffer_pool::LinuxFrameBufferPool;
use fluxer_linux_screen_capture::x11_stream::{X11VideoStream, list_monitors, x11_available};

#[test]
fn x11_backend_captures_real_frames() {
    if !x11_available() {
        eprintln!("skipping: no X11 display / MIT-SHM");
        return;
    }

    let monitors = list_monitors().expect("monitor enumeration should succeed on X11");
    assert!(!monitors.is_empty(), "expected at least one monitor");
    let monitor = monitors[0].clone();
    eprintln!(
        "capturing {} ({}x{})",
        monitor.name, monitor.width, monitor.height
    );

    let width = u32::from(monitor.width) & !1;
    let height = u32::from(monitor.height) & !1;
    let pool = LinuxFrameBufferPool::new((width * height * 3 / 2) as usize).expect("pool");

    let frames = Arc::new(AtomicU64::new(0));
    let luma_variance_seen = Arc::new(AtomicU64::new(0));

    let frames_cb = Arc::clone(&frames);
    let variance_cb = Arc::clone(&luma_variance_seen);
    let stream = X11VideoStream::open(
        monitor,
        Some(15),
        Arc::new(move |frame| {
            frames_cb.fetch_add(1, Ordering::Relaxed);
            // A frame that is a single flat colour (the "green screen" failure mode) has no
            // variation in the luma plane. Real desktop content always does.
            let y_len = (frame.stride_y * frame.height) as usize;
            let data = frame.data.as_slice();
            if data.len() >= y_len && y_len > 0 {
                let first = data[0];
                if data[..y_len].iter().any(|&b| b != first) {
                    variance_cb.fetch_add(1, Ordering::Relaxed);
                }
            }
        }),
        Arc::new(|state: &str, detail: &str| eprintln!("lifecycle: {state} {detail}")),
        pool,
        None,
    )
    .expect("stream should open");

    std::thread::sleep(std::time::Duration::from_millis(1200));
    stream.stop();

    let got = frames.load(Ordering::Relaxed);
    let varied = luma_variance_seen.load(Ordering::Relaxed);
    eprintln!("frames={got} frames_with_luma_variance={varied}");
    assert!(got >= 5, "expected several frames in 1.2s, got {got}");
    assert!(
        varied > 0,
        "every frame was a flat colour - capture produced no real content"
    );
}
