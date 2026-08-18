import Foundation

/// What one painted frame consists of, in cell coordinates.
///
/// Cells rather than pixels on purpose. The grid is the thing the emulator
/// knows about, and keeping the frame in its units means changing the font size
/// is a different multiply on the way to the GPU rather than a reason to go ask
/// the emulator for the screen again.
///
/// Built entirely off the main thread. The renderer's whole job on the main
/// thread is to turn this into two buffers and hand them to Metal.

/// A solid rectangle: a background run, a decoration, the cursor, a selection,
/// a search hit. One instance type for all of them because they are all a
/// coloured quad and the GPU does not care what they mean.
struct FillRun {
    var col: UInt16
    var row: UInt16
    /// In cells. Backgrounds coalesce, so this is usually much more than one.
    var width: UInt16
    var style: FillStyle
    var color: RGBA
}

/// Where in the cell the fill sits and what shape it takes. The renderer owns
/// the arithmetic — it is the only side that knows the font's ascent.
enum FillStyle: UInt16 {
    case background = 0
    case underline
    case doubleUnderline
    case curlyUnderline
    case dottedUnderline
    case dashedUnderline
    case strikethrough
    case selection
    case cursorBlock
    case cursorBar
    case cursorUnderline
    /// The hollow block an unfocused terminal draws, so it is obvious which
    /// pane the keyboard is going to.
    case cursorHollow
    case searchHit
    case searchHitCurrent
}

/// One cell that has something to draw in it.
///
/// One instance per cell, not per run of shared attributes. A terminal is a
/// fixed grid — every glyph lands in its own slot at a known advance — so runs
/// buy nothing but the bookkeeping to maintain them, and cost the ability to
/// place a glyph exactly where its column says it goes.
struct GlyphRun {
    var col: UInt16
    var row: UInt16
    var scalar: UInt32
    var color: RGBA
    /// Only the font-affecting bits of `CellFlags`: bold and italic.
    var style: UInt16
    /// 2 for the left half of a double-width character, 1 otherwise. The
    /// renderer widens the source rect rather than clipping the glyph.
    var cellWidth: UInt16
}

struct CursorState {
    var row = 0
    var col = 0
    var visible = false
    var style = FillStyle.cursorBlock
    /// DECSCUSR asked for a blinking shape. Honoured only while the terminal
    /// has the keyboard — a cursor blinking in a pane you are not typing into
    /// is movement in the corner of the eye and nothing else.
    var blinks = true
}

/// One complete, immutable frame. Handed across the queue boundary by value;
/// the arrays are copy-on-write, so a renderer holding one while the engine
/// builds the next costs nothing until the engine actually reuses the storage.
struct TerminalFrame {
    var cols = 0
    var rows = 0
    /// Backgrounds and decorations, drawn first.
    var fills: [FillRun] = []
    /// Drawn over the backgrounds but *under* the text: the selection tint,
    /// and anything else that must not make what it covers unreadable.
    var highlights: [FillRun] = []
    var glyphs: [GlyphRun] = []
    var cursor = CursorState()
    var displayOffset = 0
    var scrollbackLength = 0
    var altScreen = false
    /// What the key and pointer encoders need, as of this frame — see
    /// `dp_term_key_modes`. Carried here rather than read live so that
    /// encoding a keystroke never has to wait on the engine's queue.
    var keyModes: UInt32 = 0
    /// Bumped whenever the engine publishes. The renderer skips a frame it has
    /// already drawn, which is what makes an idle terminal free.
    var generation: UInt64 = 0

    var isEmpty: Bool { cols == 0 || rows == 0 }
}
