import Metal
import MetalKit
import simd

/// Turns a `TerminalFrame` into two instanced draws.
///
/// The old renderer rasterised the whole view with CoreText on the main thread
/// every time one character changed, because `setNeedsDisplay()` invalidates
/// everything. On a 13-inch iPad that is five and a half million pixels of CPU
/// text drawing for a cursor blink. This one uploads a few hundred instances
/// and lets the GPU do what it is for.
///
/// The other half of the win is that an idle terminal costs nothing at all:
/// there is no display link, no timer, and no draw. The engine publishes a
/// frame only when the emulator reports damage, and the view draws only when
/// the engine publishes.
final class TerminalRenderer {
    /// Mirrors `FillInstance` in Shaders.metal.
    private struct FillInstance {
        var rect: SIMD4<Float>
        var color: UInt32
        var style: UInt32
    }

    /// Mirrors `GlyphInstance` in Shaders.metal.
    private struct GlyphInstance {
        var rect: SIMD4<Float>
        var uv: SIMD4<Float>
        var color: UInt32
        var isColor: UInt32
    }

    private struct Uniforms {
        var viewport: SIMD2<Float>
    }

    let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private let fillPipeline: MTLRenderPipelineState
    private let glyphPipeline: MTLRenderPipelineState
    private let sampler: MTLSamplerState
    let atlas: GlyphAtlas

    private var theme: Theme

    /// Three frames in flight, which is what the semaphore counts. Writing to
    /// a buffer the GPU is still reading is the classic Metal corruption, and
    /// it looks exactly like a renderer bug rather than a synchronisation one.
    private static let inFlight = 3
    private let frameSemaphore = DispatchSemaphore(value: inFlight)
    private var fillBuffers: [GrowableBuffer]
    private var glyphBuffers: [GrowableBuffer]
    private var slot = 0

    /// Scratch that never leaves the main thread, so building a frame's
    /// instances allocates nothing after the first few.
    private var fillScratch: [FillInstance] = []
    private var glyphScratch: [GlyphInstance] = []

    var metrics: FontMetrics { atlas.metrics }

    init?(device: MTLDevice, pixelFormat: MTLPixelFormat, theme: Theme) {
        guard let commandQueue = device.makeCommandQueue(),
            let library = Self.loadLibrary(device: device),
            let atlas = GlyphAtlas(device: device)
        else { return nil }

        self.device = device
        self.commandQueue = commandQueue
        self.atlas = atlas
        self.theme = theme

        func pipeline(_ vertex: String, _ fragment: String) -> MTLRenderPipelineState? {
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = library.makeFunction(name: vertex)
            descriptor.fragmentFunction = library.makeFunction(name: fragment)
            let attachment = descriptor.colorAttachments[0]!
            attachment.pixelFormat = pixelFormat
            // Premultiplied throughout: the atlas comes out of CoreGraphics
            // that way and both fragment shaders output it.
            attachment.isBlendingEnabled = true
            attachment.rgbBlendOperation = .add
            attachment.alphaBlendOperation = .add
            attachment.sourceRGBBlendFactor = .one
            attachment.sourceAlphaBlendFactor = .one
            attachment.destinationRGBBlendFactor = .oneMinusSourceAlpha
            attachment.destinationAlphaBlendFactor = .oneMinusSourceAlpha
            return try? device.makeRenderPipelineState(descriptor: descriptor)
        }

        guard let fill = pipeline("fill_vertex", "fill_fragment"),
            let glyph = pipeline("glyph_vertex", "glyph_fragment")
        else { return nil }
        self.fillPipeline = fill
        self.glyphPipeline = glyph

        // Nearest, and it has to be. Cell metrics are whole pixels and glyph
        // rects are whole pixels, so every texel lands on exactly one pixel;
        // filtering would only fetch a neighbour's edge and blur the text.
        let samplerDescriptor = MTLSamplerDescriptor()
        samplerDescriptor.minFilter = .nearest
        samplerDescriptor.magFilter = .nearest
        samplerDescriptor.sAddressMode = .clampToEdge
        samplerDescriptor.tAddressMode = .clampToEdge
        guard let sampler = device.makeSamplerState(descriptor: samplerDescriptor) else {
            return nil
        }
        self.sampler = sampler

        self.fillBuffers = (0..<Self.inFlight).map { _ in GrowableBuffer(device: device) }
        self.glyphBuffers = (0..<Self.inFlight).map { _ in GrowableBuffer(device: device) }
    }

    /// The shader library, precompiled into the bundle by the build script.
    private static func loadLibrary(device: MTLDevice) -> MTLLibrary? {
        if let url = Bundle.main.url(forResource: "default", withExtension: "metallib"),
            let library = try? device.makeLibrary(URL: url)
        {
            return library
        }
        return device.makeDefaultLibrary()
    }

    func setFont(pointSize: CGFloat, scale: CGFloat) {
        atlas.setFont(pointSize: pointSize, scale: scale)
    }

    func setTheme(_ theme: Theme) {
        self.theme = theme
    }

    /// Columns and rows that fit a drawable of this pixel size.
    func gridSize(forDrawable size: CGSize) -> (cols: Int, rows: Int) {
        let m = atlas.metrics
        guard m.cellWidth > 0, m.cellHeight > 0 else { return (80, 24) }
        return (
            max(1, Int(size.width) / m.cellWidth),
            max(1, Int(size.height) / m.cellHeight)
        )
    }

    /// Everything the renderer needs that the emulator does not know about.
    struct Overlay {
        var focused = true
        /// Blink phase; the cursor is hidden on the off beat.
        var cursorOn = true
        /// Search results currently on screen, in visible-row coordinates.
        var searchHits: [FillRun] = []
        /// The link under a finger, underlined while it is held.
        var touchedLink: FillRun?
    }

    func draw(_ frame: TerminalFrame, in view: MTKView, overlay: Overlay) {
        guard !frame.isEmpty,
            let descriptor = view.currentRenderPassDescriptor,
            let drawable = view.currentDrawable
        else { return }

        let size = view.drawableSize
        guard size.width > 0, size.height > 0 else { return }

        frameSemaphore.wait()
        slot = (slot + 1) % Self.inFlight

        buildInstances(frame, overlay: overlay)

        let fills = fillBuffers[slot]
        let glyphs = glyphBuffers[slot]
        fills.write(fillScratch)
        glyphs.write(glyphScratch)

        var uniforms = Uniforms(viewport: SIMD2(Float(size.width), Float(size.height)))

        guard let command = commandQueue.makeCommandBuffer(),
            let encoder = command.makeRenderCommandEncoder(descriptor: descriptor)
        else {
            frameSemaphore.signal()
            return
        }

        if !fillScratch.isEmpty, let buffer = fills.buffer {
            encoder.setRenderPipelineState(fillPipeline)
            encoder.setVertexBuffer(buffer, offset: 0, index: 0)
            encoder.setVertexBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 1)
            encoder.drawPrimitives(
                type: .triangle, vertexStart: 0, vertexCount: 6,
                instanceCount: fillScratch.count)
        }

        if !glyphScratch.isEmpty, let buffer = glyphs.buffer {
            encoder.setRenderPipelineState(glyphPipeline)
            encoder.setVertexBuffer(buffer, offset: 0, index: 0)
            encoder.setVertexBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 1)
            encoder.setFragmentTexture(atlas.texture, index: 0)
            encoder.setFragmentSamplerState(sampler, index: 0)
            encoder.drawPrimitives(
                type: .triangle, vertexStart: 0, vertexCount: 6,
                instanceCount: glyphScratch.count)
        }

        encoder.endEncoding()
        command.addCompletedHandler { [frameSemaphore] _ in frameSemaphore.signal() }
        command.present(drawable)
        command.commit()
    }

    // MARK: - instances

    private func buildInstances(_ frame: TerminalFrame, overlay: Overlay) {
        fillScratch.removeAll(keepingCapacity: true)
        glyphScratch.removeAll(keepingCapacity: true)

        // Order is the whole contract: backgrounds and decorations, then
        // anything that tints without hiding, then the text, then the cursor —
        // and finally the one character a block cursor sits on, redrawn in the
        // background colour so it reads as knocked out rather than buried.
        for run in frame.fills { append(fill: run) }
        for run in frame.highlights { append(fill: run) }
        for hit in overlay.searchHits { append(fill: hit) }
        for glyph in frame.glyphs { append(glyph: glyph) }
        if let link = overlay.touchedLink { append(fill: link) }
        appendCursor(frame, overlay: overlay)
    }

    private func append(fill run: FillRun) {
        let m = atlas.metrics
        let cellWidth = Float(m.cellWidth)
        let cellHeight = Float(m.cellHeight)
        let x = Float(run.col) * cellWidth
        let y = Float(run.row) * cellHeight
        let width = Float(run.width) * cellWidth
        let ascent = Float(m.ascent)
        let thickness = Float(m.underlineThickness)
        // Kept inside the cell: an underline that spills into the row below
        // clips the tops of the letters there.
        let underlineY = min(y + ascent + Float(m.underlineOffset), y + cellHeight - thickness)
        let color = run.color.packed

        func emit(_ rect: SIMD4<Float>, _ style: FillStyle) {
            fillScratch.append(
                FillInstance(rect: rect, color: color, style: UInt32(style.rawValue)))
        }

        switch run.style {
        case .background, .selection, .searchHit, .searchHitCurrent:
            emit([x, y, width, cellHeight], .background)
        case .underline, .dottedUnderline, .dashedUnderline:
            emit([x, underlineY, width, thickness], run.style)
        case .doubleUnderline:
            emit([x, underlineY, width, thickness], .background)
            let second = min(underlineY + thickness * 2, y + cellHeight - thickness)
            emit([x, second, width, thickness], .background)
        case .curlyUnderline:
            // Room for the wave, which the fragment shader draws inside.
            let height = max(3, thickness * 3)
            emit([x, min(underlineY - 1, y + cellHeight - height), width, height], .curlyUnderline)
        case .strikethrough:
            emit([x, y + ascent * 0.62, width, thickness], .background)
        case .cursorBlock:
            emit([x, y, width, cellHeight], .background)
        case .cursorBar:
            emit([x, y, max(2, cellWidth * 0.18), cellHeight], .background)
        case .cursorUnderline:
            let height = max(2, thickness * 2)
            emit([x, y + cellHeight - height, width, height], .background)
        case .cursorHollow:
            // Four edges rather than a filled block: the pane does not have the
            // keyboard, and saying so is worth four instances.
            let edge: Float = max(1, thickness)
            emit([x, y, width, edge], .background)
            emit([x, y + cellHeight - edge, width, edge], .background)
            emit([x, y, edge, cellHeight], .background)
            emit([x + width - edge, y, edge, cellHeight], .background)
        }
    }

    private func append(glyph: GlyphRun, colorOverride: RGBA? = nil) {
        guard let slot = atlas.slot(scalar: glyph.scalar, style: glyph.style), !slot.isEmpty
        else { return }
        let m = atlas.metrics
        let originX = Float(glyph.col) * Float(m.cellWidth)
        let baseline = Float(glyph.row) * Float(m.cellHeight) + Float(m.ascent)

        glyphScratch.append(
            GlyphInstance(
                rect: [originX + slot.left, baseline + slot.top, slot.width, slot.height],
                uv: [slot.u0, slot.v0, slot.u1, slot.v1],
                color: (colorOverride ?? glyph.color).packed,
                isColor: slot.isColor ? 1 : 0))
    }

    private func appendCursor(_ frame: TerminalFrame, overlay: Overlay) {
        // While scrolled back, the cursor's row is a history line it has
        // nothing to do with, and drawing it there lands a block on an
        // unrelated character.
        guard frame.displayOffset == 0, frame.cursor.visible else { return }
        guard frame.cursor.row < frame.rows, frame.cursor.col < frame.cols else { return }
        if overlay.focused, frame.cursor.blinks, !overlay.cursorOn { return }

        let style: FillStyle = overlay.focused ? frame.cursor.style : .cursorHollow
        append(
            fill: FillRun(
                col: UInt16(frame.cursor.col), row: UInt16(frame.cursor.row), width: 1,
                style: style, color: theme.cursor))

        // Knock the character out of a filled block, so the cursor never hides
        // what it is sitting on.
        guard overlay.focused, style == .cursorBlock else { return }
        let row = frame.cursor.row
        let col = frame.cursor.col
        if let under = frame.glyphs.first(where: { Int($0.row) == row && Int($0.col) == col }) {
            append(glyph: under, colorOverride: theme.background)
        }
    }
}

/// A device buffer that grows to whatever the frame needed and then stops
/// growing, because the frame after it needs about the same.
private final class GrowableBuffer {
    private let device: MTLDevice
    private(set) var buffer: MTLBuffer?
    private var capacity = 0

    init(device: MTLDevice) {
        self.device = device
    }

    func write<T>(_ items: [T]) {
        guard !items.isEmpty else { return }
        let stride = MemoryLayout<T>.stride
        let needed = items.count * stride
        if capacity < needed {
            // Doubling, so a terminal that grows by a row at a time does not
            // reallocate on every one of them.
            capacity = max(needed, capacity * 2, 4096)
            buffer = device.makeBuffer(length: capacity, options: .storageModeShared)
        }
        guard let buffer else { return }
        items.withUnsafeBytes { source in
            guard let base = source.baseAddress else { return }
            buffer.contents().copyMemory(from: base, byteCount: needed)
        }
    }
}
