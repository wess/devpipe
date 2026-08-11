//! A C ABI over sinclair's `vt` so a Swift client can own terminal state.
//!
//! The client runs the emulator locally and the server ships raw PTY bytes.
//! That is what buys local echo: a keystroke paints before the round trip.
//! The alternative — server renders, client paints diffs — costs a full RTT
//! on every character, which on cellular is the difference between a terminal
//! that feels alive and one that does not.
//!
//! Swift never touches a `Cell`. It calls `feed`, then reads a packed
//! `[DpCell]` for the visible screen in one go; per-cell FFI calls across
//! 10k cells a frame would cost more than the emulation does.

use std::ffi::c_char;
use vt::{Cell, CellFlags, Color, Terminal};

/// Owns the emulator plus the snapshot buffer we hand back to Swift.
pub struct DpTerm {
    term: Terminal,
    cells: Vec<DpCell>,
    /// Reused by `dp_term_take_output`, which hands out a pointer to it.
    /// Lives until the next call, which is all the caller needs.
    out: Vec<u8>,
    title: Vec<u8>,
    link: Vec<u8>,
}

/// One cell, flattened for the renderer. 16 bytes, `Copy`, no pointers — the
/// whole visible grid is one contiguous read on the Swift side.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct DpCell {
    /// Unicode scalar. Wide spacers are `0`, which the renderer skips.
    pub ch: u32,
    pub fg: u32,
    pub bg: u32,
    pub flags: u16,
    _pad: u16,
}

/// Cursor and screen state that changes every frame but isn't per-cell.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct DpScreen {
    pub cols: u32,
    pub rows: u32,
    pub cursor_row: u32,
    pub cursor_col: u32,
    pub cursor_visible: u8,
    pub cursor_style: u8,
    pub alt_screen: u8,
    _pad: u8,
}

/// Colors pack into a `u32` as `tag << 24 | payload`, so the renderer resolves
/// them against its own palette instead of us baking a theme into the core.
/// tag 0 = terminal default, 1 = 256-color index, 2 = 24-bit rgb.
fn pack_color(c: Color) -> u32 {
    match c {
        Color::Default => 0,
        Color::Indexed(i) => (1 << 24) | i as u32,
        Color::Rgb(r, g, b) => (2 << 24) | ((r as u32) << 16) | ((g as u32) << 8) | b as u32,
    }
}

fn pack_cell(c: &Cell) -> DpCell {
    DpCell {
        // A wide character occupies two columns; the spacer carries no glyph
        // and must not be drawn, or the second half overstrikes the first.
        ch: if c.flags.contains(CellFlags::WIDE_SPACER) {
            0
        } else {
            c.ch as u32
        },
        fg: pack_color(c.fg),
        bg: pack_color(c.bg),
        flags: c.flags.bits(),
        _pad: 0,
    }
}

/// # Safety
/// The returned pointer must be freed with `dp_term_free`.
#[unsafe(no_mangle)]
pub extern "C" fn dp_term_new(cols: u32, rows: u32, scrollback: u32) -> *mut DpTerm {
    let cols = cols.max(1) as usize;
    let rows = rows.max(1) as usize;
    let t = Box::new(DpTerm {
        term: Terminal::new(cols, rows, scrollback as usize),
        cells: Vec::with_capacity(cols * rows),
        out: Vec::new(),
        title: Vec::new(),
        link: Vec::new(),
    });
    Box::into_raw(t)
}

/// # Safety
/// `t` must come from `dp_term_new` and must not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_free(t: *mut DpTerm) {
    if !t.is_null() {
        drop(unsafe { Box::from_raw(t) });
    }
}

/// # Safety
/// `bytes` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_feed(t: *mut DpTerm, bytes: *const u8, len: usize) {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return;
    };
    if bytes.is_null() || len == 0 {
        return;
    }
    t.term.feed(unsafe { std::slice::from_raw_parts(bytes, len) });
}

/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_resize(t: *mut DpTerm, cols: u32, rows: u32) {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return;
    };
    t.term.resize(cols.max(1) as usize, rows.max(1) as usize);
}

/// Refresh the snapshot buffer and return a pointer to `cols * rows` cells in
/// row-major order. Valid until the next `dp_term_snapshot` or the free.
///
/// # Safety
/// `t` must come from `dp_term_new`; `out` must be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_snapshot(t: *mut DpTerm, out: *mut DpScreen) -> *const DpCell {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return std::ptr::null();
    };
    let (cols, rows) = (t.term.cols(), t.term.rows());

    t.cells.clear();
    t.cells.reserve(cols * rows);
    for r in 0..rows {
        let row = t.term.visible_row(r);
        for c in 0..cols {
            // `visible_row` is authoritative for length, but a row can be
            // shorter than the terminal is wide right after a resize.
            let cell = row.cells.get(c).copied().unwrap_or_default();
            t.cells.push(pack_cell(&cell));
        }
    }

    if let Some(out) = unsafe { out.as_mut() } {
        let (cr, cc) = t.term.cursor_pos();
        *out = DpScreen {
            cols: cols as u32,
            rows: rows as u32,
            cursor_row: cr as u32,
            cursor_col: cc as u32,
            cursor_visible: t.term.cursor_visible() as u8,
            cursor_style: t.term.cursor_style() as u8,
            alt_screen: t.term.is_alt_screen() as u8,
            _pad: 0,
        };
    }
    t.cells.as_ptr()
}

/// Bytes the emulator wants written back to the PTY — cursor position reports,
/// device attributes, focus events. Dropping these hangs anything that asks
/// the terminal a question and waits for the answer.
///
/// # Safety
/// `t` must come from `dp_term_new`; `len` must be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_take_output(t: *mut DpTerm, len: *mut usize) -> *const u8 {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return std::ptr::null();
    };
    t.out = t.term.take_output();
    if let Some(len) = unsafe { len.as_mut() } {
        *len = t.out.len();
    }
    t.out.as_ptr()
}

/// NUL-terminated window title, valid until the next call.
///
/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_title(t: *mut DpTerm) -> *const c_char {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return std::ptr::null();
    };
    t.title.clear();
    t.title.extend_from_slice(t.term.title().as_bytes());
    t.title.push(0);
    t.title.as_ptr() as *const c_char
}

/// Which rows changed since the last call. Returns `-1` for full damage,
/// otherwise the number of dirty row indices written to `rows` (capped at
/// `cap`; a truncated list escalates to `-1` rather than silently dropping
/// rows the renderer would then leave stale).
///
/// A renderer that repacks and repaints all 10k cells every frame spends most
/// of its time redrawing a screen that did not change. An idle terminal
/// should cost nothing.
///
/// # Safety
/// `t` must come from `dp_term_new`; `rows` must be writable for `cap` u32s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_take_damage(
    t: *mut DpTerm,
    rows: *mut u32,
    cap: usize,
) -> i32 {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return 0;
    };
    match t.term.take_damage() {
        vt::Damage::Full => -1,
        vt::Damage::Rows(dirty) => {
            if rows.is_null() || dirty.len() > cap {
                return if dirty.is_empty() { 0 } else { -1 };
            }
            let out = unsafe { std::slice::from_raw_parts_mut(rows, dirty.len()) };
            for (o, r) in out.iter_mut().zip(&dirty) {
                *o = *r as u32;
            }
            dirty.len() as i32
        }
    }
}

/// The link under a cell, or null. Writes the inclusive column span so the
/// renderer can underline exactly what a tap would open.
///
/// This is how a login flow becomes usable on a tablet. Claude Code's OAuth
/// prints a URL several hundred characters long and asks you to open it; with
/// no way to tap it, the only alternative is transcribing it by hand.
/// `link_at` covers both OSC 8 hyperlinks and URLs merely printed as text,
/// which matters because the ones that show up here are the latter.
///
/// # Safety
/// `t` must come from `dp_term_new`. The returned pointer is valid until the
/// next call to this function or the free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_link_at(
    t: *mut DpTerm,
    row: u32,
    col: u32,
    start_col: *mut u32,
    end_col: *mut u32,
) -> *const c_char {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return std::ptr::null();
    };
    let Some(hit) = t.term.link_at(row as usize, col as usize) else {
        return std::ptr::null();
    };
    if let Some(s) = unsafe { start_col.as_mut() } {
        *s = hit.start_col as u32;
    }
    if let Some(e) = unsafe { end_col.as_mut() } {
        *e = hit.end_col as u32;
    }
    t.link.clear();
    t.link.extend_from_slice(hit.url.as_bytes());
    t.link.push(0);
    t.link.as_ptr() as *const c_char
}

/// Keyboard-relevant modes, as bits: 1 = application cursor keys,
/// 2 = application keypad, 4 = bracketed paste.
///
/// The client cannot encode an arrow key without this. A TUI that has set
/// DECCKM expects `ESC O A` and will ignore the `ESC [ A` a naive client
/// sends — which is exactly how arrow keys end up dead inside a full-screen
/// program while working fine at a shell prompt.
///
/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_key_modes(t: *mut DpTerm) -> u32 {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return 0;
    };
    (t.term.cursor_keys_app() as u32)
        | ((t.term.keypad_app() as u32) << 1)
        | ((t.term.bracketed_paste() as u32) << 2)
}

/// Scroll the viewport through scrollback. Positive scrolls back, negative
/// toward the live bottom, and both clamp to `[0, dp_term_scrollback_len]`.
///
/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_scroll(t: *mut DpTerm, delta: isize) {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return;
    };
    t.term.scroll_display(delta);
}

/// How far the viewport sits above the live bottom, in rows. Zero means the
/// snapshot is the running screen.
///
/// The core never scrolls itself back to the bottom on output — vt pins the
/// offset to the content it was showing as new rows push into history — so a
/// client decides for itself when to follow the tail. That decision needs this:
/// "am I at the bottom" is the difference between new output stealing your
/// place mid-read and it not.
///
/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_display_offset(t: *mut DpTerm) -> usize {
    let Some(t) = (unsafe { t.as_ref() }) else {
        return 0;
    };
    t.term.display_offset()
}

/// Rows of history behind the live screen — the largest offset a scroll can
/// reach. Zero on the alternate screen, which keeps no scrollback, so a client
/// can use it to tell whether scrolling means anything at all right now.
///
/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_scrollback_len(t: *mut DpTerm) -> usize {
    let Some(t) = (unsafe { t.as_ref() }) else {
        return 0;
    };
    t.term.grid().scrollback().len()
}

/// Jump back to the live bottom.
///
/// Separate from `dp_term_scroll` with a large negative delta because the
/// clients call it on every keystroke: typing while scrolled up and seeing
/// nothing happen reads as a hung terminal.
///
/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_scroll_to_bottom(t: *mut DpTerm) {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return;
    };
    t.term.set_display_offset(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(t: *mut DpTerm) -> (DpScreen, Vec<DpCell>) {
        let mut s = DpScreen {
            cols: 0,
            rows: 0,
            cursor_row: 0,
            cursor_col: 0,
            cursor_visible: 0,
            cursor_style: 0,
            alt_screen: 0,
            _pad: 0,
        };
        let p = unsafe { dp_term_snapshot(t, &mut s) };
        let cells =
            unsafe { std::slice::from_raw_parts(p, (s.cols * s.rows) as usize) }.to_vec();
        (s, cells)
    }

    #[test]
    fn plain_text_lands_in_the_grid() {
        let t = dp_term_new(20, 5, 100);
        unsafe { dp_term_feed(t, b"hi".as_ptr(), 2) };
        let (s, cells) = snap(t);
        assert_eq!((s.cols, s.rows), (20, 5));
        assert_eq!(cells[0].ch, 'h' as u32);
        assert_eq!(cells[1].ch, 'i' as u32);
        assert_eq!(s.cursor_col, 2);
        unsafe { dp_term_free(t) };
    }

    #[test]
    fn sgr_colors_survive_the_packing() {
        let t = dp_term_new(20, 2, 0);
        // truecolor red fg, then 256-color bg
        let seq = b"\x1b[38;2;255;0;0mR\x1b[48;5;33mB";
        unsafe { dp_term_feed(t, seq.as_ptr(), seq.len()) };
        let (_, cells) = snap(t);
        assert_eq!(cells[0].fg, (2 << 24) | (255 << 16));
        assert_eq!(cells[1].bg, (1 << 24) | 33);
        unsafe { dp_term_free(t) };
    }

    #[test]
    fn wide_chars_blank_their_spacer() {
        let t = dp_term_new(10, 2, 0);
        let seq = "世".as_bytes();
        unsafe { dp_term_feed(t, seq.as_ptr(), seq.len()) };
        let (_, cells) = snap(t);
        assert_eq!(cells[0].ch, '世' as u32);
        assert_eq!(cells[1].ch, 0, "spacer must not draw a second glyph");
        unsafe { dp_term_free(t) };
    }

    #[test]
    fn cursor_position_report_comes_back_as_output() {
        let t = dp_term_new(80, 24, 0);
        unsafe { dp_term_feed(t, b"\x1b[6n".as_ptr(), 4) };
        let mut len = 0usize;
        let p = unsafe { dp_term_take_output(t, &mut len) };
        let out = unsafe { std::slice::from_raw_parts(p, len) };
        assert_eq!(out, b"\x1b[1;1R");
        unsafe { dp_term_free(t) };
    }

    #[test]
    fn a_printed_url_is_findable_by_tapping_it() {
        let t = dp_term_new(80, 4, 0);
        // Not a hyperlink — just text, which is how an OAuth prompt prints it.
        let line = b"Open https://claude.com/cai/oauth/authorize?code=true to sign in";
        unsafe { dp_term_feed(t, line.as_ptr(), line.len()) };

        let (mut start, mut end) = (0u32, 0u32);
        // Column 12 is inside the url, column 2 is inside the word "Open".
        let p = unsafe { dp_term_link_at(t, 0, 12, &mut start, &mut end) };
        assert!(!p.is_null(), "a tap inside the url should find it");
        let url = unsafe { std::ffi::CStr::from_ptr(p) }.to_str().unwrap();
        assert_eq!(url, "https://claude.com/cai/oauth/authorize?code=true");
        assert_eq!(start, 5, "span starts where the url does");
        assert_eq!(end as usize, 5 + url.len() - 1);

        let miss = unsafe { dp_term_link_at(t, 0, 2, &mut start, &mut end) };
        assert!(miss.is_null(), "a tap on ordinary text should find nothing");
        unsafe { dp_term_free(t) };
    }

    /// Text of one visible row, trailing blanks trimmed.
    fn row_text(t: *mut DpTerm, row: usize) -> String {
        let (s, cells) = snap(t);
        let cols = s.cols as usize;
        let mut out = String::new();
        for c in 0..cols {
            let ch = cells[row * cols + c].ch;
            if ch != 0 {
                out.push(char::from_u32(ch).unwrap_or(' '));
            }
        }
        out.trim_end().to_string()
    }

    /// `n` numbered lines, each its own row.
    fn feed_lines(t: *mut DpTerm, n: usize) {
        let text: String = (0..n).map(|i| format!("line {i}\r\n")).collect();
        unsafe { dp_term_feed(t, text.as_ptr(), text.len()) };
    }

    #[test]
    fn output_past_the_screen_goes_to_scrollback_and_scrolls_back() {
        let t = dp_term_new(20, 4, 100);
        feed_lines(t, 10);
        // Ten lines plus the row the cursor sits on, through a four-row
        // screen, leaves seven rows behind it.
        assert_eq!(unsafe { dp_term_scrollback_len(t) }, 7);
        assert_eq!(unsafe { dp_term_display_offset(t) }, 0);
        assert_eq!(row_text(t, 0), "line 7");

        unsafe { dp_term_scroll(t, 3) };
        assert_eq!(unsafe { dp_term_display_offset(t) }, 3);
        assert_eq!(row_text(t, 0), "line 4");
        unsafe { dp_term_free(t) };
    }

    #[test]
    fn scrolling_past_either_end_clamps() {
        let t = dp_term_new(20, 4, 100);
        feed_lines(t, 10);

        unsafe { dp_term_scroll(t, 9999) };
        assert_eq!(unsafe { dp_term_display_offset(t) }, 7, "stops at the oldest row");
        assert_eq!(row_text(t, 0), "line 0");

        unsafe { dp_term_scroll(t, -9999) };
        assert_eq!(unsafe { dp_term_display_offset(t) }, 0, "and cannot go below live");
        unsafe { dp_term_free(t) };
    }

    #[test]
    fn a_scrolled_view_holds_its_place_until_told_otherwise() {
        let t = dp_term_new(20, 4, 100);
        feed_lines(t, 10);
        unsafe { dp_term_scroll(t, 4) };
        let anchored = row_text(t, 0);

        feed_lines(t, 5);
        assert_eq!(
            row_text(t, 0),
            anchored,
            "output must not drag a reader off the line they were reading"
        );

        unsafe { dp_term_scroll_to_bottom(t) };
        assert_eq!(unsafe { dp_term_display_offset(t) }, 0);
        assert_eq!(row_text(t, 0), "line 2", "back on the live tail");
        unsafe { dp_term_free(t) };
    }

    #[test]
    fn the_alternate_screen_has_nothing_to_scroll() {
        let t = dp_term_new(20, 4, 100);
        feed_lines(t, 20);
        unsafe { dp_term_feed(t, b"\x1b[?1049h".as_ptr(), 8) };
        assert_eq!(unsafe { dp_term_scrollback_len(t) }, 0);
        unsafe { dp_term_scroll(t, 5) };
        assert_eq!(unsafe { dp_term_display_offset(t) }, 0);
        unsafe { dp_term_free(t) };
    }

    #[test]
    fn resize_reflows_without_going_out_of_bounds() {
        let t = dp_term_new(80, 24, 100);
        let filler = "x".repeat(500);
        unsafe { dp_term_feed(t, filler.as_ptr(), filler.len()) };
        unsafe { dp_term_resize(t, 40, 12) };
        let (s, cells) = snap(t);
        assert_eq!((s.cols, s.rows), (40, 12));
        assert_eq!(cells.len(), 40 * 12);
        unsafe { dp_term_free(t) };
    }
}

/// Allocation helpers for hosts without a C allocator — that is, WebAssembly.
///
/// The iOS client passes pointers it got from Swift; a browser has no such
/// thing, so JS asks the module for a buffer, writes bytes into the module's
/// own linear memory, and hands the offset back. Without these there is no way
/// to get a single byte of pty output into the emulator from JavaScript.
///
/// # Safety
/// `dp_free` must be called with the exact length passed to `dp_alloc`.
#[unsafe(no_mangle)]
pub extern "C" fn dp_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` must come from `dp_alloc` with the same `len`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
    }
}

/// Size of `DpCell`, so a JS reader can stride the snapshot without hardcoding
/// a number that would silently break if the struct ever grew.
#[unsafe(no_mangle)]
pub extern "C" fn dp_cell_size() -> usize {
    std::mem::size_of::<DpCell>()
}
