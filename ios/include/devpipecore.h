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

// Bits: 1 = application cursor keys, 2 = application keypad,
// 4 = bracketed paste. Arrow keys cannot be encoded without this.
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

#endif
