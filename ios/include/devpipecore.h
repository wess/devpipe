// C ABI for devpipecore. Kept in sync by hand with core/src/lib.rs — small
// enough that cbindgen would be more machinery than it saves, but the struct
// layouts must match exactly or the renderer reads garbage.
#ifndef DEVPIPECORE_H
#define DEVPIPECORE_H

#include <stdint.h>
#include <stddef.h>

typedef struct DpTerm DpTerm;

// 16 bytes. Colors pack as (tag << 24 | payload):
//   tag 0 = terminal default, 1 = 256-color index, 2 = 24-bit rgb.
typedef struct {
  uint32_t ch;   // unicode scalar; 0 means draw nothing (wide-char spacer)
  uint32_t fg;
  uint32_t bg;
  uint16_t flags;
  uint16_t _pad;
} DpCell;

typedef struct {
  uint32_t cols;
  uint32_t rows;
  uint32_t cursor_row;
  uint32_t cursor_col;
  uint8_t cursor_visible;
  uint8_t cursor_style;
  uint8_t alt_screen;
  uint8_t _pad;
} DpScreen;

DpTerm *dp_term_new(uint32_t cols, uint32_t rows, uint32_t scrollback);
void dp_term_free(DpTerm *t);
void dp_term_feed(DpTerm *t, const uint8_t *bytes, size_t len);
void dp_term_resize(DpTerm *t, uint32_t cols, uint32_t rows);

// Returns cols*rows cells, row-major. Valid until the next snapshot or free.
const DpCell *dp_term_snapshot(DpTerm *t, DpScreen *out);

// Bytes the emulator owes the pty (cursor reports, device attributes).
const uint8_t *dp_term_take_output(DpTerm *t, size_t *len);

const char *dp_term_title(DpTerm *t);

// -1 = full damage, else count of dirty row indices written to `rows`.
int32_t dp_term_take_damage(DpTerm *t, uint32_t *rows, size_t cap);

// Everything a client needs to encode input, as bits:
//     1 application cursor keys      16 mouse: click   (?1000)
//     2 application keypad           32 mouse: drag    (?1002)
//     4 bracketed paste              64 mouse: motion  (?1003)
//     8 alternate screen active     128 SGR encoding   (?1006)
//                                   256 alternate scroll (?1007)
// Bits 0-2 are the original contract and keep their meaning, so a client built
// against an older header reads them and ignores the rest.
//
// Arrow keys cannot be encoded without the keyboard bits. The pointer bits are
// the same problem one layer out: without them a client cannot know that the
// wheel should become arrow keys on the alternate screen — where there is no
// scrollback to move through — so the gesture does nothing at all inside
// exactly the programs this product exists to run.
uint32_t dp_term_key_modes(DpTerm *t);

// URL under a cell, or NULL. Covers OSC 8 hyperlinks and plain printed URLs.
// Writes the inclusive column span of the match.
const char *dp_term_link_at(DpTerm *t, uint32_t row, uint32_t col,
                            uint32_t *start_col, uint32_t *end_col);

// Move the viewport through scrollback: positive scrolls back, negative toward
// the live bottom, both clamped to [0, dp_term_scrollback_len].
void dp_term_scroll(DpTerm *t, intptr_t delta);

// Rows the viewport sits above the live bottom; 0 means it is showing the
// running screen. The core never follows the tail on its own, so the client
// decides when new output should move the view.
size_t dp_term_display_offset(DpTerm *t);

// Rows of history behind the live screen — the largest reachable offset.
// Zero on the alternate screen, which keeps no scrollback.
size_t dp_term_scrollback_len(DpTerm *t);

void dp_term_scroll_to_bottom(DpTerm *t);

// ---- selection -------------------------------------------------------------
//
// The core owns the selection because what one *is* depends on the grid: a
// logical line runs across soft wraps, a word ends where the grid says it does,
// and a wide character is two columns but one character when copied. A client
// tracking spans itself would reimplement all of that and get the edges wrong.
//
// Points are absolute content coordinates: 0..rows-1 is the live screen and
// negative lines run back into scrollback, so a visible row `r` at display
// offset `off` is line `r - off`.

// mode: 0 = cell, 1 = word, 2 = logical line, 3 = smart (URL/path/email).
void dp_term_selection_start(DpTerm *t, intptr_t line, size_t col, uint32_t mode);

// Move the loose end — the drag.
void dp_term_selection_update(DpTerm *t, intptr_t line, size_t col);

void dp_term_selection_clear(DpTerm *t);

// Writes [start_line, start_col, end_line, end_col]; returns 1 when there is a
// selection. One call per frame rather than a per-cell predicate: a renderer
// walks thousands of cells and asking across the ABI for each costs more than
// the drawing.
uint32_t dp_term_selection_span(DpTerm *t, intptr_t *out);

// The selected text, NUL-terminated, valid until the next call. Trailing blanks
// are trimmed and soft-wrapped rows are joined without a newline — the
// difference between pasting a command back and pasting one with a line break
// through the middle of it.
const char *dp_term_selection_text(DpTerm *t);

#endif
