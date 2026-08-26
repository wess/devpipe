//! Rebuilding a client's screen when it reconnects.
//!
//! The obvious approach — keep a ring of raw pty bytes and replay it — breaks
//! in a way that is hard to see coming: the ring's start lands mid-escape and
//! the client's parser eats the following text as parameters. Worse, the ring
//! has to be big enough to contain a full-screen repaint that may have
//! happened arbitrarily long ago.
//!
//! Instead the daemon runs its own `vt::Terminal` over the same output and,
//! on attach, emits ANSI that reconstructs the screen it currently holds. It
//! is bounded by screen size rather than by history, and never truncates a
//! sequence.
//!
//! What this does not restore is scrollback: a reattached client starts with
//! the visible screen and nothing above it. Fixing that means shipping the
//! scrollback grid too, which the protocol can carry later.

use std::fmt::Write as _;

use vt::{Cell, CellFlags, Color, Terminal};

pub fn screen_as_ansi(term: &mut Terminal) -> Vec<u8> {
    let mut out = String::with_capacity(term.cols() * term.rows() * 2);

    // Enter the alt screen first if the child is in it, so the sequence lands
    // in the same buffer the child thinks it is drawing to.
    if term.is_alt_screen() {
        out.push_str("\x1b[?1049h");
    }
    out.push_str("\x1b[H\x1b[2J\x1b[m");

    let (cols, rows) = (term.cols(), term.rows());
    for r in 0..rows {
        let row: Vec<Cell> = term
            .visible_row(r)
            .cells
            .iter()
            .take(cols)
            .copied()
            .collect();

        // Trailing blanks cost bytes and paint nothing over a just-cleared
        // screen.
        let end = row
            .iter()
            .rposition(|c| c.ch != ' ' || c.bg != Color::Default || !c.flags.is_empty())
            .map(|i| i + 1)
            .unwrap_or(0);
        if end == 0 {
            continue;
        }

        let _ = write!(out, "\x1b[{};1H", r + 1);
        let mut pen: Option<(Color, Color, CellFlags)> = None;
        for cell in &row[..end] {
            if cell.flags.contains(CellFlags::WIDE_SPACER) {
                continue;
            }
            let key = (cell.fg, cell.bg, cell.flags);
            if pen != Some(key) {
                out.push_str(&sgr(cell));
                pen = Some(key);
            }
            out.push(if cell.ch == '\0' { ' ' } else { cell.ch });
            if cell.zw != '\0' {
                out.push(cell.zw);
            }
        }
        out.push_str("\x1b[m");
    }

    let (cr, cc) = term.cursor_pos();
    let _ = write!(out, "\x1b[{};{}H", cr + 1, cc + 1);
    out.push_str(if term.cursor_visible() {
        "\x1b[?25h"
    } else {
        "\x1b[?25l"
    });
    if term.bracketed_paste() {
        out.push_str("\x1b[?2004h");
    }
    out.into_bytes()
}

fn sgr(cell: &Cell) -> String {
    let mut s = String::from("\x1b[0");
    let f = cell.flags;
    for (flag, code) in [
        (CellFlags::BOLD, "1"),
        (CellFlags::DIM, "2"),
        (CellFlags::ITALIC, "3"),
        (CellFlags::UNDERLINE, "4"),
        (CellFlags::BLINK, "5"),
        (CellFlags::INVERSE, "7"),
        (CellFlags::INVISIBLE, "8"),
        (CellFlags::STRIKETHROUGH, "9"),
    ] {
        if f.contains(flag) {
            s.push(';');
            s.push_str(code);
        }
    }
    push_color(&mut s, cell.fg, true);
    push_color(&mut s, cell.bg, false);
    s.push('m');
    s
}

fn push_color(s: &mut String, c: Color, fg: bool) {
    match c {
        Color::Default => {}
        Color::Indexed(i) => {
            let _ = write!(s, ";{};5;{}", if fg { 38 } else { 48 }, i);
        }
        Color::Rgb(r, g, b) => {
            let _ = write!(s, ";{};2;{};{};{}", if fg { 38 } else { 48 }, r, g, b);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real contract: replaying into a fresh terminal must land on the
    /// same screen. Asserting on the exact bytes would just pin the encoder.
    fn roundtrip(input: &[u8], cols: usize, rows: usize) -> (Terminal, Terminal) {
        let mut a = Terminal::new(cols, rows, 100);
        a.feed(input);
        let replay = screen_as_ansi(&mut a);
        let mut b = Terminal::new(cols, rows, 100);
        b.feed(&replay);
        (a, b)
    }

    fn text(t: &mut Terminal) -> Vec<String> {
        (0..t.rows())
            .map(|r| t.row_text(r).trim_end().to_string())
            .collect()
    }

    #[test]
    fn plain_text_survives() {
        let (mut a, mut b) = roundtrip(b"hello\r\nworld", 20, 4);
        assert_eq!(text(&mut a), text(&mut b));
        assert_eq!(text(&mut b)[0], "hello");
    }

    #[test]
    fn colors_and_attributes_survive() {
        let input = b"\x1b[1;31mbold red\x1b[m plain \x1b[48;5;33mbg\x1b[m";
        let (mut a, mut b) = roundtrip(input, 40, 3);
        assert_eq!(text(&mut a), text(&mut b));
        for c in 0..8 {
            let (x, y) = (a.cell(0, c), b.cell(0, c));
            assert_eq!((x.ch, x.fg, x.flags), (y.ch, y.fg, y.flags), "col {c}");
        }
    }

    #[test]
    fn cursor_position_survives() {
        let (a, b) = roundtrip(b"abc\r\ndef\x1b[1;2H", 20, 4);
        assert_eq!(a.cursor_pos(), b.cursor_pos());
        assert_eq!(b.cursor_pos(), (0, 1));
    }

    #[test]
    fn alt_screen_is_reentered() {
        let (a, b) = roundtrip(b"\x1b[?1049hin alt screen", 30, 5);
        assert!(a.is_alt_screen());
        assert!(b.is_alt_screen(), "a reattach must land in the same buffer");
    }

    #[test]
    fn wide_characters_survive() {
        let (mut a, mut b) = roundtrip("世界 ok".as_bytes(), 20, 2);
        assert_eq!(text(&mut a), text(&mut b));
    }

    #[test]
    fn a_blank_screen_replays_as_blank() {
        let (mut a, mut b) = roundtrip(b"", 20, 4);
        assert_eq!(text(&mut a), text(&mut b));
        assert!(text(&mut b).iter().all(|l| l.is_empty()));
    }
}
