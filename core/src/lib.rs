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
use vt::selection::{Point, SelectionMode};
use vt::{Cell, CellFlags, Color, Modes, MouseMode, Terminal};

/// Owns the emulator plus the snapshot buffer we hand back to Swift.
pub struct DpTerm {
    term: Terminal,
    cells: Vec<DpCell>,
    /// Reused by `dp_term_take_output`, which hands out a pointer to it.
    /// Lives until the next call, which is all the caller needs.
    out: Vec<u8>,
    title: Vec<u8>,
    link: Vec<u8>,
    /// Reused by `dp_term_selection_text`, on the same terms as `link`.
    sel: Vec<u8>,
    /// Same again for the one-shot side channels: OSC 52 clipboard writes, OSC
    /// 7 working directory, and the OSC 9/777/99 notification a program raises
    /// when it wants attention.
    clip: Vec<u8>,
    cwd: Vec<u8>,
    note_title: Vec<u8>,
    note_body: Vec<u8>,
    /// The scrollback size the terminal was made with, so a reset can rebuild
    /// an identical one in place.
    scrollback: usize,
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
        sel: Vec::new(),
        clip: Vec::new(),
        cwd: Vec::new(),
        note_title: Vec::new(),
        note_body: Vec::new(),
        scrollback: scrollback as usize,
    });
    Box::into_raw(t)
}

/// Throw away every scrap of state and start clean at the same size.
///
/// In place, and that is the whole point of it existing. Switching sessions
/// used to mean freeing the handle and allocating another, which is fine right
/// up until a renderer is holding the pointer from the last `dp_term_snapshot`
/// — then it is a use-after-free that only shows up under load, on a device,
/// as a crash with no useful stack. The box stays put; only what is inside it
/// is replaced.
///
/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_reset(t: *mut DpTerm) {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return;
    };
    let (cols, rows) = (t.term.cols(), t.term.rows());
    t.term = Terminal::new(cols, rows, t.scrollback);
    t.cells.clear();
    t.out.clear();
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

/// Everything a client needs to encode input, as bits.
///
/// ```text
///   1  application cursor keys (DECCKM ?1)
///   2  application keypad
///   4  bracketed paste (?2004)
///   8  alternate screen active
///  16  mouse reporting: click (?1000)
///  32  mouse reporting: drag (?1002) — implies click
///  64  mouse reporting: any motion (?1003) — implies drag
/// 128  SGR mouse encoding (?1006)
/// 256  alternate scroll (?1007)
/// ```
///
/// Bits 0-2 are the original contract and keep their meaning, so a client
/// built against the old header reads them and ignores the rest.
///
/// The keyboard bits exist because a client cannot encode an arrow key
/// without them: a TUI that has set DECCKM expects `ESC O A` and ignores the
/// `ESC [ A` a naive client sends, which is how arrow keys end up dead inside
/// a full-screen program while working fine at a shell prompt.
///
/// The mouse and scroll bits are the same problem one layer out. A client that
/// cannot see them has no way to know that the wheel should become arrow keys
/// on the alternate screen — where there is no scrollback to move through —
/// or that the program has asked to receive clicks itself. Without them the
/// wheel does nothing at all inside exactly the programs people run here.
///
/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_key_modes(t: *mut DpTerm) -> u32 {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return 0;
    };
    let modes = t.term.modes();
    let mouse = match t.term.mouse_mode() {
        MouseMode::None => 0,
        MouseMode::Click => 1 << 4,
        MouseMode::Drag => 1 << 5,
        MouseMode::Motion => 1 << 6,
    };
    (t.term.cursor_keys_app() as u32)
        | ((t.term.keypad_app() as u32) << 1)
        | ((t.term.bracketed_paste() as u32) << 2)
        | ((t.term.is_alt_screen() as u32) << 3)
        | mouse
        | ((modes.contains(Modes::MOUSE_SGR) as u32) << 7)
        | ((modes.contains(Modes::ALT_SCROLL) as u32) << 8)
}

// ---- Selection -------------------------------------------------------------
//
// The core owns the selection rather than the client, because what a selection
// *is* depends on the grid: a logical line runs across soft wraps, a word stops
// where the grid says a word stops, and a wide character occupies two columns
// but is one character when copied. A client that tracked spans itself would
// reimplement all of that and get the edges wrong.
//
// Points are absolute content coordinates: `0..rows-1` is the live screen and
// negative lines run back into scrollback, so a visible row `r` at display
// offset `off` is line `r - off`.

/// Begin a selection. `mode` is 0 = cell, 1 = word, 2 = line, 3 = smart —
/// a double click is word, a triple click is line.
///
/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_selection_start(t: *mut DpTerm, line: isize, col: usize, mode: u32) {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return;
    };
    let mode = match mode {
        1 => SelectionMode::Word,
        2 => SelectionMode::Line,
        3 => SelectionMode::Smart,
        _ => SelectionMode::Cell,
    };
    t.term.start_selection(mode, Point::new(line, col));
}

/// Move the selection's loose end — the drag.
///
/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_selection_update(t: *mut DpTerm, line: isize, col: usize) {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return;
    };
    t.term.update_selection(Point::new(line, col));
}

/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_selection_clear(t: *mut DpTerm) {
    if let Some(t) = unsafe { t.as_mut() } {
        t.term.clear_selection();
    }
}

/// Writes `[start_line, start_col, end_line, end_col]` and returns 1 when
/// there is a selection, 0 when there is not.
///
/// One call per frame rather than a per-cell predicate: the renderer walks
/// thousands of cells, and asking across the ABI for each one costs more than
/// the drawing does.
///
/// # Safety
/// `t` must come from `dp_term_new`; `out` must be writable for four `isize`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_selection_span(t: *mut DpTerm, out: *mut isize) -> u32 {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return 0;
    };
    let Some(sel) = t.term.selection() else {
        return 0;
    };
    let (start, end) = (sel.start(), sel.end());
    if let Some(out) = unsafe { out.as_mut() } {
        let slots = unsafe { std::slice::from_raw_parts_mut(out as *mut isize, 4) };
        slots[0] = start.line;
        slots[1] = start.col as isize;
        slots[2] = end.line;
        slots[3] = end.col as isize;
    }
    1
}

/// The selected text, NUL-terminated and valid until the next call.
///
/// Trailing blanks on each row are trimmed and soft-wrapped rows are joined
/// without a newline, which is the difference between pasting a command back
/// and pasting a command with a line break through the middle of it.
///
/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_selection_text(t: *mut DpTerm) -> *const c_char {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return std::ptr::null();
    };
    let Some(text) = t.term.selection_text() else {
        return std::ptr::null();
    };
    t.sel.clear();
    t.sel.extend_from_slice(text.as_bytes());
    t.sel.push(0);
    t.sel.as_ptr() as *const c_char
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

/// Jump the viewport to an exact offset above the live bottom.
///
/// `dp_term_scroll` moves by a delta, which is what a finger does. Search
/// wants to land on a known line instead, and computing a delta from the
/// current offset to get there is the sort of arithmetic that is right until
/// output arrives between the read and the write.
///
/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_set_display_offset(t: *mut DpTerm, offset: usize) {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return;
    };
    t.term.set_display_offset(offset);
}

// ---- one-shot events -------------------------------------------------------
//
// Everything here is drained: asking clears it. They are gathered behind a
// single call because a client has to ask on every pump and five FFI calls to
// be told "no" five times is four more than the answer is worth.

/// Bits returned by `dp_term_take_events`.
pub const DP_EVENT_BELL: u32 = 1 << 0;
pub const DP_EVENT_TITLE: u32 = 1 << 1;
pub const DP_EVENT_CWD: u32 = 1 << 2;
pub const DP_EVENT_CLIPBOARD: u32 = 1 << 3;
pub const DP_EVENT_NOTIFICATION: u32 = 1 << 4;
pub const DP_EVENT_COMMAND_DONE: u32 = 1 << 5;

/// What happened since the last call, as bits, with the payloads parked on the
/// terminal for the follow-up reads that the bits say are worth making.
///
/// The notification bit is the interesting one on a tablet. A coding agent that
/// wants permission raises OSC 9, and until now that went nowhere: the whole
/// premise of leaving an agent running on a box is that it can reach you when
/// it gets stuck, and the client it was most likely to be stuck in front of
/// silently dropped the one message that says so.
///
/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_take_events(t: *mut DpTerm) -> u32 {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return 0;
    };
    let mut bits = 0;
    if t.term.take_bell() {
        bits |= DP_EVENT_BELL;
    }
    if t.term.take_title_changed().is_some() {
        bits |= DP_EVENT_TITLE;
    }
    if let Some(cwd) = t.term.take_cwd_changed() {
        t.cwd.clear();
        t.cwd.extend_from_slice(cwd.as_bytes());
        t.cwd.push(0);
        bits |= DP_EVENT_CWD;
    }
    if let Some(clip) = t.term.take_clipboard() {
        t.clip.clear();
        t.clip.extend_from_slice(&clip.data);
        t.clip.push(0);
        bits |= DP_EVENT_CLIPBOARD;
    }
    if let Some(note) = t.term.take_notification() {
        t.note_title.clear();
        t.note_title
            .extend_from_slice(note.title.unwrap_or_default().as_bytes());
        t.note_title.push(0);
        t.note_body.clear();
        t.note_body.extend_from_slice(note.body.as_bytes());
        t.note_body.push(0);
        bits |= DP_EVENT_NOTIFICATION;
    }
    if t.term.take_command_finished().is_some() {
        bits |= DP_EVENT_COMMAND_DONE;
    }
    bits
}

/// The working directory OSC 7 last reported, valid until the next event drain.
///
/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_cwd(t: *mut DpTerm) -> *const c_char {
    unsafe { borrowed(t, |t| &t.cwd) }
}

/// The payload of the last OSC 52 clipboard write.
///
/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_clipboard(t: *mut DpTerm) -> *const c_char {
    unsafe { borrowed(t, |t| &t.clip) }
}

/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_notification_title(t: *mut DpTerm) -> *const c_char {
    unsafe { borrowed(t, |t| &t.note_title) }
}

/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_notification_body(t: *mut DpTerm) -> *const c_char {
    unsafe { borrowed(t, |t| &t.note_body) }
}

/// Shared tail of the string getters: a NUL-terminated borrow of one of the
/// terminal's scratch buffers, or null when it is empty.
///
/// # Safety
/// `t` must come from `dp_term_new`.
unsafe fn borrowed(t: *mut DpTerm, pick: fn(&DpTerm) -> &Vec<u8>) -> *const c_char {
    let Some(t) = (unsafe { t.as_ref() }) else {
        return std::ptr::null();
    };
    let buf = pick(t);
    if buf.is_empty() {
        return std::ptr::null();
    }
    buf.as_ptr() as *const c_char
}

/// Whether the program has asked for its update to land atomically (?2026).
///
/// A TUI that repaints in several writes brackets them, and a client that
/// presents a frame in the middle of that shows the half-drawn state. It is the
/// difference between a redraw and a flicker, and it is most visible in exactly
/// the full-screen programs this product exists to run.
///
/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_synchronized_output(t: *mut DpTerm) -> u8 {
    let Some(t) = (unsafe { t.as_ref() }) else {
        return 0;
    };
    t.term.synchronized_output() as u8
}

/// Tell the program the window gained or lost focus (?1004), if it asked.
///
/// # Safety
/// `t` must come from `dp_term_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_report_focus(t: *mut DpTerm, focused: u8) {
    if let Some(t) = unsafe { t.as_mut() } {
        t.term.report_focus(focused != 0);
    }
}

// ---- search ----------------------------------------------------------------

/// One hit, in the global line space: `0..scrollback_len-1` is history and
/// `scrollback_len..` is the live screen. Columns are inclusive.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct DpMatch {
    pub line: u32,
    pub start_col: u32,
    pub end_col: u32,
    _pad: u32,
}

/// Find every occurrence of `needle` across scrollback and the live screen.
///
/// Returns the total number of matches, which may exceed `cap` — only the first
/// `cap` are written, so a caller can size a buffer from the answer and ask
/// again, or simply cap what it is willing to highlight.
///
/// # Safety
/// `t` must come from `dp_term_new`; `needle` must be NUL-terminated; `out`
/// must be writable for `cap` `DpMatch`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dp_term_search(
    t: *mut DpTerm,
    needle: *const c_char,
    case_sensitive: u8,
    out: *mut DpMatch,
    cap: usize,
) -> i32 {
    let Some(t) = (unsafe { t.as_mut() }) else {
        return 0;
    };
    if needle.is_null() {
        return 0;
    }
    let Ok(needle) = (unsafe { std::ffi::CStr::from_ptr(needle) }).to_str() else {
        return 0;
    };
    let hits = t.term.search(needle, case_sensitive != 0);
    if !out.is_null() && cap > 0 {
        let n = hits.len().min(cap);
        let slots = unsafe { std::slice::from_raw_parts_mut(out, n) };
        for (slot, hit) in slots.iter_mut().zip(&hits) {
            *slot = DpMatch {
                line: hit.line as u32,
                start_col: hit.start_col as u32,
                end_col: hit.end_col as u32,
                _pad: 0,
            };
        }
    }
    hits.len() as i32
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

    #[test]
    fn reset_clears_the_screen_without_moving_the_handle() {
        let t = dp_term_new(20, 4, 100);
        feed_lines(t, 10);
        assert_eq!(unsafe { dp_term_scrollback_len(t) }, 7);

        unsafe { dp_term_reset(t) };
        assert_eq!(unsafe { dp_term_scrollback_len(t) }, 0);
        assert_eq!(row_text(t, 0), "", "the previous session must not show through");
        // Same pointer, still usable: a renderer holding it is not left with a
        // dangling one.
        unsafe { dp_term_feed(t, b"after".as_ptr(), 5) };
        assert_eq!(row_text(t, 0), "after");
        unsafe { dp_term_free(t) };
    }

    #[test]
    fn a_bell_is_reported_once() {
        let t = dp_term_new(20, 4, 0);
        unsafe { dp_term_feed(t, b"\x07".as_ptr(), 1) };
        assert_eq!(unsafe { dp_term_take_events(t) } & DP_EVENT_BELL, DP_EVENT_BELL);
        assert_eq!(unsafe { dp_term_take_events(t) } & DP_EVENT_BELL, 0, "drained");
        unsafe { dp_term_free(t) };
    }

    #[test]
    fn a_notification_carries_its_text_across() {
        let t = dp_term_new(80, 4, 0);
        // OSC 777 is the form with a title; this is what an agent raises when
        // it wants a human.
        let seq = b"\x1b]777;notify;Claude;needs your permission\x07";
        unsafe { dp_term_feed(t, seq.as_ptr(), seq.len()) };

        let bits = unsafe { dp_term_take_events(t) };
        assert_eq!(bits & DP_EVENT_NOTIFICATION, DP_EVENT_NOTIFICATION);

        let title = unsafe { std::ffi::CStr::from_ptr(dp_term_notification_title(t)) };
        let body = unsafe { std::ffi::CStr::from_ptr(dp_term_notification_body(t)) };
        assert_eq!(title.to_str().unwrap(), "Claude");
        assert_eq!(body.to_str().unwrap(), "needs your permission");
        unsafe { dp_term_free(t) };
    }

    #[test]
    fn an_osc52_write_reaches_the_client() {
        let t = dp_term_new(80, 4, 0);
        // base64 of "copied"
        let seq = b"\x1b]52;c;Y29waWVk\x07";
        unsafe { dp_term_feed(t, seq.as_ptr(), seq.len()) };
        assert_eq!(
            unsafe { dp_term_take_events(t) } & DP_EVENT_CLIPBOARD,
            DP_EVENT_CLIPBOARD
        );
        let got = unsafe { std::ffi::CStr::from_ptr(dp_term_clipboard(t)) };
        assert_eq!(got.to_str().unwrap(), "copied");
        unsafe { dp_term_free(t) };
    }

    #[test]
    fn search_finds_hits_in_history_and_on_screen() {
        let t = dp_term_new(20, 4, 100);
        feed_lines(t, 10);  // "line 0".."line 9", seven rows into scrollback

        let needle = std::ffi::CString::new("line 1").unwrap();
        let mut hits = [DpMatch { line: 0, start_col: 0, end_col: 0, _pad: 0 }; 8];
        let n = unsafe { dp_term_search(t, needle.as_ptr(), 1, hits.as_mut_ptr(), 8) };
        // "line 1" matches its own row and is a prefix of nothing else here.
        assert_eq!(n, 1);
        assert_eq!(hits[0].line, 1, "still in scrollback");
        assert_eq!((hits[0].start_col, hits[0].end_col), (0, 5));

        // A needle on the live screen, which starts at scrollback_len.
        let sb = unsafe { dp_term_scrollback_len(t) };
        let needle = std::ffi::CString::new("line 8").unwrap();
        let n = unsafe { dp_term_search(t, needle.as_ptr(), 1, hits.as_mut_ptr(), 8) };
        assert_eq!(n, 1);
        assert_eq!(hits[0].line as usize, sb + 1);
        unsafe { dp_term_free(t) };
    }

    #[test]
    fn search_reports_a_total_larger_than_the_buffer_it_filled() {
        let t = dp_term_new(20, 6, 100);
        feed_lines(t, 10);
        let needle = std::ffi::CString::new("line").unwrap();
        let mut two = [DpMatch { line: 0, start_col: 0, end_col: 0, _pad: 0 }; 2];
        let n = unsafe { dp_term_search(t, needle.as_ptr(), 0, two.as_mut_ptr(), 2) };
        assert_eq!(n, 10, "the count is the truth, not what fitted");
        unsafe { dp_term_free(t) };
    }

    #[test]
    fn synchronized_output_is_visible_to_the_client() {
        let t = dp_term_new(20, 4, 0);
        assert_eq!(unsafe { dp_term_synchronized_output(t) }, 0);
        unsafe { dp_term_feed(t, b"\x1b[?2026h".as_ptr(), 8) };
        assert_eq!(unsafe { dp_term_synchronized_output(t) }, 1, "hold the frame");
        unsafe { dp_term_feed(t, b"\x1b[?2026l".as_ptr(), 8) };
        assert_eq!(unsafe { dp_term_synchronized_output(t) }, 0);
        unsafe { dp_term_free(t) };
    }

    #[test]
    fn a_word_selection_comes_back_as_text() {
        let t = dp_term_new(40, 4, 0);
        let line = b"run /usr/local/bin/thing --now";
        unsafe { dp_term_feed(t, line.as_ptr(), line.len()) };

        // Column 10 is inside the path. Word mode is what a long press does,
        // and the point of it is that the whole path comes back rather than
        // the fragment between two slashes.
        unsafe { dp_term_selection_start(t, 0, 10, 1) };
        let p = unsafe { dp_term_selection_text(t) };
        assert!(!p.is_null(), "a word selection must yield text");
        let text = unsafe { std::ffi::CStr::from_ptr(p) }.to_str().unwrap();
        assert_eq!(text, "/usr/local/bin/thing");

        let mut span = [0isize; 4];
        assert_eq!(unsafe { dp_term_selection_span(t, span.as_mut_ptr()) }, 1);
        assert_eq!((span[0], span[1]), (0, 4), "starts at the slash");
        assert_eq!((span[2], span[3]), (0, 23), "ends at the last letter");

        unsafe { dp_term_selection_clear(t) };
        assert_eq!(unsafe { dp_term_selection_span(t, span.as_mut_ptr()) }, 0);
        assert!(unsafe { dp_term_selection_text(t) }.is_null());
        unsafe { dp_term_free(t) };
    }

    #[test]
    fn a_dragged_selection_spans_rows_and_trims_the_ends() {
        let t = dp_term_new(20, 4, 100);
        let text = "alpha\r\nbeta\r\ngamma\r\n";
        unsafe { dp_term_feed(t, text.as_ptr(), text.len()) };

        // Cell mode, from the start of "alpha" to the end of "beta" — the drag
        // a finger makes after a long press.
        unsafe { dp_term_selection_start(t, 0, 0, 0) };
        unsafe { dp_term_selection_update(t, 1, 3) };
        let p = unsafe { dp_term_selection_text(t) };
        assert!(!p.is_null());
        let got = unsafe { std::ffi::CStr::from_ptr(p) }.to_str().unwrap();
        // Trailing blanks trimmed per row, rows joined by a newline: the
        // difference between pasting two commands back and pasting two
        // commands padded out to the width of the terminal.
        assert_eq!(got, "alpha\nbeta");
        unsafe { dp_term_free(t) };
    }

    #[test]
    fn focus_reports_only_when_the_program_asked() {
        let t = dp_term_new(20, 4, 0);
        unsafe { dp_term_report_focus(t, 1) };
        let mut len = 0usize;
        unsafe { dp_term_take_output(t, &mut len) };
        assert_eq!(len, 0, "silent until ?1004 is set");

        unsafe { dp_term_feed(t, b"\x1b[?1004h".as_ptr(), 8) };
        unsafe { dp_term_report_focus(t, 1) };
        let p = unsafe { dp_term_take_output(t, &mut len) };
        assert_eq!(unsafe { std::slice::from_raw_parts(p, len) }, b"\x1b[I");
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
