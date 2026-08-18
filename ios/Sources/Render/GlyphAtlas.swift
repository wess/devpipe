import CoreGraphics
import CoreText
import Metal
import UIKit

/// The font, measured in device pixels.
///
/// Pixels, not points, and integers, because the grid has to land on pixel
/// boundaries or every column drifts by a fraction and the text turns to mush.
/// A terminal is the one place where "close enough" spacing is visible on every
/// line of every screen.
struct FontMetrics: Equatable {
    var cellWidth: Int
    var cellHeight: Int
    var ascent: Int
    var underlineOffset: Int
    var underlineThickness: Int
    /// Points per pixel — what the view divides by to lay out in UIKit units.
    var scale: CGFloat
    var pointSize: CGFloat

    static let zero = FontMetrics(
        cellWidth: 1, cellHeight: 1, ascent: 1, underlineOffset: 1,
        underlineThickness: 1, scale: 1, pointSize: 13)
}

/// Rasterised glyphs, packed into one texture.
///
/// A terminal draws the same few hundred glyphs over and over, so they are
/// rasterised once and then only ever sampled. Slots are shelf-packed rather
/// than fixed-size: a box-drawing character that overflows its cell, a wide CJK
/// glyph and an emoji all need different room, and a grid of identical slots
/// either clips them or wastes most of the texture.
final class GlyphAtlas {
    /// Where one glyph sits, and how to place it against a cell.
    struct Slot {
        /// Texture coordinates, already normalised.
        var u0: Float, v0: Float, u1: Float, v1: Float
        /// Offset from the cell's left edge and from the baseline, in pixels.
        var left: Float, top: Float
        var width: Float, height: Float
        /// Emoji and other colour fonts carry their own colour and must not be
        /// tinted by the cell's foreground.
        var isColor: Bool
    }

    private struct Key: Hashable {
        let scalar: UInt32
        let style: UInt16
    }

    let texture: MTLTexture
    private(set) var metrics = FontMetrics.zero

    /// Bumped when the atlas is cleared, so anything caching a slot knows to
    /// ask again rather than sampling whatever moved into its coordinates.
    private(set) var generation: UInt64 = 0

    private let size: Int
    private var slots: [Key: Slot] = [:]
    /// ASCII is nearly all of what a terminal draws, so it skips the dictionary
    /// entirely: four style variants of 0x20..0x7E, indexed directly.
    private var ascii: [Slot?]

    private var shelfX = 0
    private var shelfY = 0
    private var shelfHeight = 0
    private let padding = 1

    /// Regular, bold, italic, bold-italic — indexed by the font-affecting bits
    /// of `CellFlags`, which is why the table has gaps.
    private var fonts: [CTFont?] = Array(repeating: nil, count: 8)
    /// Fallback faces found for characters the base font has no glyph for,
    /// kept so an emoji is not re-resolved on every frame it appears in.
    private var fallbacks: [UInt32: CTFont] = [:]

    private let bytesPerPixel = 4

    init?(device: MTLDevice, size: Int = 2048) {
        self.size = size
        self.ascii = Array(repeating: nil, count: 95 * 4)

        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba8Unorm, width: size, height: size, mipmapped: false)
        descriptor.usage = .shaderRead
        descriptor.storageMode = .shared
        guard let texture = device.makeTexture(descriptor: descriptor) else { return nil }
        self.texture = texture
        clearTexture()
    }

    // MARK: - font

    /// Point size and screen scale, together, because the rasteriser works in
    /// pixels and needs both to get there.
    func setFont(pointSize: CGFloat, scale: CGFloat) {
        let pixelSize = (pointSize * scale).rounded()
        guard pixelSize > 0 else { return }

        func face(_ traits: UIFontDescriptor.SymbolicTraits) -> CTFont {
            // SF Mono via the system's monospace face: every cell advances the
            // same width, which is what lets the renderer place a glyph by
            // column index instead of measuring what came before it.
            let base = UIFont.monospacedSystemFont(
                ofSize: pixelSize, weight: traits.contains(.traitBold) ? .semibold : .regular)
            let descriptor =
                traits.isEmpty
                ? base.fontDescriptor
                : (base.fontDescriptor.withSymbolicTraits(traits) ?? base.fontDescriptor)
            return CTFontCreateWithFontDescriptor(descriptor as CTFontDescriptor, pixelSize, nil)
        }

        fonts = Array(repeating: nil, count: 8)
        fonts[0] = face([])
        fonts[Int(CellFlags.bold.rawValue)] = face(.traitBold)
        fonts[Int(CellFlags.italic.rawValue)] = face(.traitItalic)
        fonts[Int(CellFlags.bold.union(.italic).rawValue)] = face([.traitBold, .traitItalic])

        let regular = fonts[0]!
        var glyph = CGGlyph(0)
        var ch = UniChar(77)  // "M"
        CTFontGetGlyphsForCharacters(regular, &ch, &glyph, 1)
        var advance = CGSize.zero
        CTFontGetAdvancesForGlyphs(regular, .horizontal, &glyph, &advance, 1)

        let ascent = CTFontGetAscent(regular)
        let descent = CTFontGetDescent(regular)
        let leading = CTFontGetLeading(regular)
        // A little extra leading: SF Mono's own is 0, and lines packed with no
        // gap at all read as a wall on a screen this dense.
        let lineGap = max(leading, (ascent + descent) * 0.13)

        metrics = FontMetrics(
            cellWidth: max(1, Int(advance.width.rounded())),
            cellHeight: max(1, Int((ascent + descent + lineGap).rounded(.up))),
            ascent: max(1, Int((ascent + lineGap * 0.5).rounded())),
            underlineOffset: max(1, Int((-CTFontGetUnderlinePosition(regular)).rounded())),
            underlineThickness: max(1, Int(CTFontGetUnderlineThickness(regular).rounded())),
            scale: scale,
            pointSize: pointSize)

        reset()
    }

    /// Throw every cached glyph away. Cheap, and the only correct answer to a
    /// font change: the slots hold pixels rasterised at the old size.
    func reset() {
        slots.removeAll(keepingCapacity: true)
        for i in ascii.indices { ascii[i] = nil }
        fallbacks.removeAll(keepingCapacity: true)
        shelfX = 0
        shelfY = 0
        shelfHeight = 0
        generation &+= 1
        clearTexture()
    }

    // MARK: - lookup

    /// The slot for a character, rasterising it if this is the first time.
    ///
    /// Returns nil for a character with nothing to draw — a space, or one no
    /// installed font has a glyph for.
    func slot(scalar: UInt32, style: UInt16) -> Slot? {
        if let index = asciiIndex(scalar: scalar, style: style) {
            if let cached = ascii[index] { return cached }
            let made = rasterize(scalar: scalar, style: style)
            ascii[index] = made ?? .empty
            return made
        }
        let key = Key(scalar: scalar, style: style)
        if let cached = slots[key] { return cached.isEmpty ? nil : cached }
        let made = rasterize(scalar: scalar, style: style)
        slots[key] = made ?? .empty
        return made
    }

    private func asciiIndex(scalar: UInt32, style: UInt16) -> Int? {
        guard scalar >= 0x21, scalar <= 0x7E else { return nil }
        let face =
            switch style {
            case CellFlags.bold.rawValue: 1
            case CellFlags.italic.rawValue: 2
            case CellFlags.bold.union(.italic).rawValue: 3
            default: 0
            }
        return Int(scalar - 0x21) * 4 + face
    }

    // MARK: - rasterisation

    private func rasterize(scalar: UInt32, style: UInt16) -> Slot? {
        guard let unicode = Unicode.Scalar(scalar) else { return nil }
        let base = fonts[Int(style) & 7] ?? fonts[0]
        guard let base else { return nil }

        var utf16 = Array(String(unicode).utf16)
        var glyphs = [CGGlyph](repeating: 0, count: utf16.count)
        var font = base
        if !CTFontGetGlyphsForCharacters(base, &utf16, &glyphs, utf16.count) || glyphs[0] == 0 {
            // Nothing in the monospace face. Emoji and most CJK land here, and
            // the fallback is cached because resolving one costs a font-manager
            // query that is far more expensive than drawing the glyph.
            if let cached = fallbacks[scalar] {
                font = cached
            } else {
                let text = String(unicode) as CFString
                let fallback = CTFontCreateForString(
                    base, text, CFRange(location: 0, length: CFStringGetLength(text)))
                fallbacks[scalar] = fallback
                font = fallback
            }
            guard CTFontGetGlyphsForCharacters(font, &utf16, &glyphs, utf16.count),
                glyphs[0] != 0
            else { return nil }
        }
        let glyph = glyphs[0]

        var bounds = CGRect.zero
        withUnsafePointer(to: glyph) { p in
            bounds = CTFontGetBoundingRectsForGlyphs(font, .horizontal, p, nil, 1)
        }
        guard bounds.width > 0, bounds.height > 0, bounds.width.isFinite, bounds.height.isFinite
        else { return nil }

        // Font space is y-up from the baseline; the texture is y-down from the
        // top. `top` carries the conversion so the renderer only has to add it
        // to the baseline.
        let x0 = Int(bounds.minX.rounded(.down)) - padding
        let y1 = Int(bounds.maxY.rounded(.up)) + padding
        let width = Int(bounds.maxX.rounded(.up)) - x0 + padding
        let height = y1 - Int(bounds.minY.rounded(.down)) + padding
        guard width > 0, height > 0, width < size, height < size else { return nil }

        guard let origin = allocate(width: width, height: height) else { return nil }

        let bytesPerRow = width * bytesPerPixel
        var pixels = [UInt8](repeating: 0, count: bytesPerRow * height)
        let isColor = CTFontGetSymbolicTraits(font).contains(.traitColorGlyphs)

        let drawn: Bool = pixels.withUnsafeMutableBytes { raw -> Bool in
            guard
                let ctx = CGContext(
                    data: raw.baseAddress, width: width, height: height,
                    bitsPerComponent: 8, bytesPerRow: bytesPerRow,
                    space: CGColorSpaceCreateDeviceRGB(),
                    // Premultiplied, matching the blend the shader expects, and
                    // matching what a colour font hands over unchanged.
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            else { return false }

            ctx.setAllowsAntialiasing(true)
            ctx.setShouldAntialias(true)
            ctx.setShouldSmoothFonts(false)  // no subpixel AA: the tint is ours
            ctx.setAllowsFontSubpixelPositioning(false)
            ctx.setShouldSubpixelPositionFonts(false)
            // White for a monochrome glyph, so the shader can multiply the
            // cell's foreground through the coverage in the alpha channel.
            ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)

            // The glyph origin sits at the baseline; place it so the bounding
            // box lands inside the bitmap.
            let position = CGPoint(x: CGFloat(-x0), y: CGFloat(height - y1))
            withUnsafePointer(to: glyph) { g in
                withUnsafePointer(to: position) { p in
                    CTFontDrawGlyphs(font, g, p, 1, ctx)
                }
            }
            return true
        }
        guard drawn else { return nil }

        texture.replace(
            region: MTLRegionMake2D(origin.x, origin.y, width, height),
            mipmapLevel: 0, withBytes: pixels, bytesPerRow: bytesPerRow)

        let inverse = Float(1.0 / Double(size))
        return Slot(
            u0: Float(origin.x) * inverse,
            v0: Float(origin.y) * inverse,
            u1: Float(origin.x + width) * inverse,
            v1: Float(origin.y + height) * inverse,
            left: Float(x0),
            top: Float(-y1),
            width: Float(width),
            height: Float(height),
            isColor: isColor)
    }

    /// Shelf allocation: fill a row left to right, start a new one when it no
    /// longer fits, give up when the sheet is full.
    private func allocate(width: Int, height: Int) -> (x: Int, y: Int)? {
        if shelfX + width > size {
            shelfY += shelfHeight
            shelfX = 0
            shelfHeight = 0
        }
        if shelfY + height > size {
            // Out of room. Two thousand glyphs is far past any real session, so
            // this is a session that has been running a very long time rather
            // than a size to design around: start the sheet over and let the
            // visible glyphs re-rasterise on the next frame.
            reset()
            if height > size { return nil }
        }
        let origin = (x: shelfX, y: shelfY)
        shelfX += width + padding
        shelfHeight = max(shelfHeight, height + padding)
        return origin
    }

    private func clearTexture() {
        let blank = [UInt8](repeating: 0, count: size * bytesPerPixel)
        for row in 0..<size {
            texture.replace(
                region: MTLRegionMake2D(0, row, size, 1), mipmapLevel: 0,
                withBytes: blank, bytesPerRow: size * bytesPerPixel)
        }
    }
}

extension GlyphAtlas.Slot {
    /// A character that resolved to nothing. Cached like any other so it is
    /// not looked up again on every frame it appears in.
    static let empty = GlyphAtlas.Slot(
        u0: 0, v0: 0, u1: 0, v1: 0, left: 0, top: 0, width: 0, height: 0, isColor: false)

    var isEmpty: Bool { width == 0 || height == 0 }
}
