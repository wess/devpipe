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

// Wipe every scrap of state, same size, *same pointer*. Freeing and
// reallocating instead is a use-after-free the moment a renderer is still
// holding the last snapshot.
void dp_term_reset(DpTerm *t);

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

// ---- events ----------------------------------------------------------------
//
// All drained: asking clears. Gathered behind one call because a client asks on
// every pump, and five FFI round trips to be told "no" five times is four more
// than the answer is worth.

#define DP_EVENT_BELL         (1u << 0)
#define DP_EVENT_TITLE        (1u << 1)
#define DP_EVENT_CWD          (1u << 2)
#define DP_EVENT_CLIPBOARD    (1u << 3)
#define DP_EVENT_NOTIFICATION (1u << 4)
#define DP_EVENT_COMMAND_DONE (1u << 5)

// What happened since the last call. Payloads are parked on the terminal for
// the follow-up reads the bits say are worth making, and stay valid until the
// next drain.
//
// The notification bit is the one that matters on a tablet: an agent that wants
// permission raises OSC 9/777/99, and the whole premise of leaving one running
// on a box is that it can reach you when it gets stuck.
uint32_t dp_term_take_events(DpTerm *t);

const char *dp_term_cwd(DpTerm *t);
const char *dp_term_clipboard(DpTerm *t);            // last OSC 52 write
const char *dp_term_notification_title(DpTerm *t);
const char *dp_term_notification_body(DpTerm *t);

// The program has asked for its update to land atomically (?2026). Presenting
// mid-bracket is the difference between a redraw and a flicker.
uint8_t dp_term_synchronized_output(DpTerm *t);

// Tell the program focus changed (?1004), if it asked to be told.
void dp_term_report_focus(DpTerm *t, uint8_t focused);

// Land the viewport on an exact offset. `dp_term_scroll` takes a delta, which
// is what a finger does; search wants a known line, and deriving a delta to get
// there races output arriving between the read and the write.
void dp_term_set_display_offset(DpTerm *t, size_t offset);

// ---- search ----------------------------------------------------------------

// Global line space: 0..scrollback_len-1 is history, scrollback_len.. is the
// live screen. Columns inclusive.
typedef struct {
  uint32_t line;
  uint32_t start_col;
  uint32_t end_col;
  uint32_t _pad;
} DpMatch;

// Returns the TOTAL number of matches, which may exceed `cap` — only the first
// `cap` are written, so a caller can size a buffer from the answer or simply
// cap what it is willing to highlight.
int32_t dp_term_search(DpTerm *t, const char *needle, uint8_t case_sensitive,
                       DpMatch *out, size_t cap);

#endif
