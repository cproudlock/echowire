// SPDX-License-Identifier: AGPL-3.0-or-later
//! Echowire: exercises the X11 capture backend against the live display.
//! Skips (passes) when no X11 display is reachable, so CI on headless boxes stays green.

#![cfg(target_os = "linux")]

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use fluxer_linux_screen_capture::frame_buffer_pool::LinuxFrameBufferPool;
use fluxer_linux_screen_capture::x11_stream::{
    X11VideoStream, list_monitors, list_windows, x11_available,
};

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
        None,
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

#[test]
fn x11_backend_captures_a_window() {
    if !x11_available() {
        eprintln!("skipping: no X11 display / MIT-SHM");
        return;
    }
    let windows = list_windows().expect("window enumeration should succeed on X11");
    if windows.is_empty() {
        eprintln!("skipping: no viewable top-level windows");
        return;
    }
    // Obscured windows read back flat on X11 without a compositor, so try candidates until one
    // yields real content rather than asserting on an arbitrary pick.
    let mut candidates: Vec<_> = windows;
    candidates.sort_by_key(|w| std::cmp::Reverse(u32::from(w.width) * u32::from(w.height)));
    let mut captured_any = false;
    for window in candidates.into_iter().take(6) {
        eprintln!(
            "trying window '{}' ({}x{})",
            window.title, window.width, window.height
        );

        let width = u32::from(window.width) & !1;
        let height = u32::from(window.height) & !1;
        let pool = LinuxFrameBufferPool::new((width * height * 3 / 2) as usize).expect("pool");

        let frames = Arc::new(AtomicU64::new(0));
        let varied = Arc::new(AtomicU64::new(0));
        let frames_cb = Arc::clone(&frames);
        let varied_cb = Arc::clone(&varied);

        let stream = X11VideoStream::open_window(
            window,
            None,
            Some(15),
            Arc::new(move |frame| {
                frames_cb.fetch_add(1, Ordering::Relaxed);
                let y_len = (frame.stride_y * frame.height) as usize;
                let data = frame.data.as_slice();
                if data.len() >= y_len && y_len > 0 {
                    let first = data[0];
                    if data[..y_len].iter().any(|&b| b != first) {
                        varied_cb.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }),
            Arc::new(|state: &str, detail: &str| eprintln!("lifecycle: {state} {detail}")),
            pool,
            None,
        )
        .expect("window stream should open");

        std::thread::sleep(std::time::Duration::from_millis(600));
        stream.stop();

        let got = frames.load(Ordering::Relaxed);
        let with_content = varied.load(Ordering::Relaxed);
        eprintln!("  frames={got} with_content={with_content}");
        assert!(got >= 3, "expected frames from window capture, got {got}");
        if with_content > 0 {
            captured_any = true;
            break;
        }
    }
    assert!(captured_any, "no window produced non-flat frames");
}

#[test]
fn x11_backend_honours_a_requested_output_size() {
    if !x11_available() {
        eprintln!("skipping: no X11 display / MIT-SHM");
        return;
    }
    let monitor = list_monitors()
        .expect("monitors")
        .into_iter()
        .next()
        .expect("one monitor");
    let native_w = u32::from(monitor.width) & !1;
    let native_h = u32::from(monitor.height) & !1;
    // Ask for a size that is deliberately not the native one - this is the case that used to be
    // ignored, leaving the pipeline expecting one resolution while frames arrived at another.
    let want_w = 1280u32;
    let want_h = 720u32;
    assert!(
        want_w != native_w || want_h != native_h,
        "test needs a non-native request"
    );

    let pool = LinuxFrameBufferPool::new((want_w * want_h * 3 / 2) as usize).expect("pool");
    let frames = Arc::new(AtomicU64::new(0));
    let right_size = Arc::new(AtomicU64::new(0));
    let varied = Arc::new(AtomicU64::new(0));
    let (fc, rc, vc) = (
        Arc::clone(&frames),
        Arc::clone(&right_size),
        Arc::clone(&varied),
    );

    let stream = X11VideoStream::open(
        monitor,
        Some((want_w, want_h)),
        Some(15),
        Arc::new(move |frame| {
            fc.fetch_add(1, Ordering::Relaxed);
            if frame.width == want_w && frame.height == want_h {
                rc.fetch_add(1, Ordering::Relaxed);
            }
            let y_len = (frame.stride_y * frame.height) as usize;
            let data = frame.data.as_slice();
            if data.len() >= y_len && y_len > 0 && data[..y_len].iter().any(|&b| b != data[0]) {
                vc.fetch_add(1, Ordering::Relaxed);
            }
        }),
        Arc::new(|state: &str, detail: &str| eprintln!("lifecycle: {state} {detail}")),
        pool,
        None,
    )
    .expect("scaled stream should open");

    std::thread::sleep(std::time::Duration::from_millis(1200));
    stream.stop();

    let got = frames.load(Ordering::Relaxed);
    let sized = right_size.load(Ordering::Relaxed);
    let content = varied.load(Ordering::Relaxed);
    eprintln!("scaled frames={got} at_requested_size={sized} with_content={content}");
    assert!(got >= 5, "expected frames, got {got}");
    assert_eq!(
        sized, got,
        "every frame must be emitted at the requested size"
    );
    assert!(content > 0, "scaled frames were all flat");
}

#[test]
fn x11_backend_throughput_at_60fps() {
    if !x11_available() {
        eprintln!("skipping");
        return;
    }
    let monitor = list_monitors()
        .expect("monitors")
        .into_iter()
        .next()
        .expect("one");
    let native_w = u32::from(monitor.width) & !1;
    let native_h = u32::from(monitor.height) & !1;
    for (label, req) in [
        ("native 1:1", None),
        ("scaled to 1080p", Some((1920u32, 1080u32))),
    ] {
        let (w, h) = req.unwrap_or((native_w, native_h));
        let pool = LinuxFrameBufferPool::new((w * h * 3 / 2) as usize).expect("pool");
        let frames = Arc::new(AtomicU64::new(0));
        let fc = Arc::clone(&frames);
        let stream = X11VideoStream::open(
            monitor.clone(),
            req,
            Some(60),
            Arc::new(move |_f| {
                fc.fetch_add(1, Ordering::Relaxed);
            }),
            Arc::new(|_s: &str, _d: &str| {}),
            pool,
            None,
        )
        .expect("open");
        std::thread::sleep(std::time::Duration::from_millis(2000));
        stream.stop();
        let got = frames.load(Ordering::Relaxed);
        eprintln!(
            "{label}: {}x{} requested 60fps -> {} frames in 2s = {:.1} fps",
            w,
            h,
            got,
            got as f64 / 2.0
        );
    }
}
