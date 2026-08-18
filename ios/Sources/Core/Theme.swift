import CoreGraphics

#if canImport(UIKit)
    import UIKit
#endif

/// Colour, packed the way the renderer wants it.
///
/// One `UInt32` as `r | g<<8 | b<<16 | a<<24`, which is what
/// `unpack_unorm4x8_to_float` reads on the GPU side. Instance data is the
/// hottest buffer in the frame and four bytes of colour beats sixteen.
struct RGBA: Equatable {
    var packed: UInt32

    init(packed: UInt32) { self.packed = packed }

    init(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) {
        func byte(_ v: Double) -> UInt32 { UInt32(max(0, min(1, v)) * 255 + 0.5) }
        packed = byte(r) | (byte(g) << 8) | (byte(b) << 16) | (byte(a) << 24)
    }

    /// From `#rrggbb`, because a theme is easier to read that way than as six
    /// floating point numbers.
    init(_ hex: UInt32, alpha: Double = 1) {
        self.init(
            Double((hex >> 16) & 0xFF) / 255,
            Double((hex >> 8) & 0xFF) / 255,
            Double(hex & 0xFF) / 255,
            alpha)
    }

    var withAlpha: (Double) -> RGBA {
        { a in
            var out = self
            let rgb = out.packed & 0x00FF_FFFF
            out.packed = rgb | (UInt32(max(0, min(1, a)) * 255 + 0.5) << 24)
            return out
        }
    }

    var cgColor: CGColor {
        CGColor(
            red: Double(packed & 0xFF) / 255,
            green: Double((packed >> 8) & 0xFF) / 255,
            blue: Double((packed >> 16) & 0xFF) / 255,
            alpha: Double((packed >> 24) & 0xFF) / 255)
    }

    #if canImport(UIKit)
        var uiColor: UIColor { UIColor(cgColor: cgColor) }
    #endif

    /// Blend toward `other`. Used for the dim attribute and for the tinted
    /// surfaces the chrome is built from.
    func mixed(with other: RGBA, _ amount: Double) -> RGBA {
        func chan(_ shift: UInt32) -> Double {
            Double((packed >> shift) & 0xFF) / 255
        }
        func otherChan(_ shift: UInt32) -> Double {
            Double((other.packed >> shift) & 0xFF) / 255
        }
        func lerp(_ shift: UInt32) -> Double {
            chan(shift) + (otherChan(shift) - chan(shift)) * amount
        }
        return RGBA(lerp(0), lerp(8), lerp(16), Double((packed >> 24) & 0xFF) / 255)
    }
}

/// What the core's colour tags mean here.
///
/// The emulator deliberately bakes in no theme — it ships `Default`,
/// `Indexed` and `Rgb` and the client decides what those look like, which is
/// what lets the theme change without touching the emulator.
struct Theme {
    // Chrome. Deliberately a narrow range: the terminal is the content, and a
    // sidebar that competes with it for attention is a sidebar in the way.
    let background: RGBA
    let surface: RGBA
    let surfaceRaised: RGBA
    let border: RGBA

    // Text.
    let foreground: RGBA
    let muted: RGBA
    let faint: RGBA

    // Accents.
    let accent: RGBA
    let cursor: RGBA
    let selection: RGBA
    let warning: RGBA
    let good: RGBA

    /// The 16 named ANSI colours, then the 6×6×6 cube, then 24 greys.
    let ansi: [RGBA]

    /// Devpipe's own. A cool slate ground with a blue accent — chosen so that
    /// a full-colour TUI sitting on top of it still reads as the brighter
    /// thing on screen.
    static let dark: Theme = {
        let named: [UInt32] = [
            0x1F_2430, 0xF0_6C75, 0x8F_CC7A, 0xE5_C07B,
            0x6F_B1FA, 0xC6_92E8, 0x6B_CCCC, 0xD6_DAE3,
            0x59_6274, 0xFA_8288, 0xA8_E091, 0xFA_D989,
            0x8E_C6FF, 0xDD_ADFA, 0x87_E3E3, 0xFA_FCFF,
        ]
        var table = named.map { RGBA($0) }
        let steps: [Double] = [0, 95, 135, 175, 215, 255].map { $0 / 255 }
        for r in 0..<6 {
            for g in 0..<6 {
                for b in 0..<6 {
                    table.append(RGBA(steps[r], steps[g], steps[b]))
                }
            }
        }
        for i in 0..<24 {
            let v = (8.0 + Double(i) * 10.0) / 255
            table.append(RGBA(v, v, v))
        }

        return Theme(
            background: RGBA(0x12_1419),
            surface: RGBA(0x16_191F),
            surfaceRaised: RGBA(0x1D_212A),
            border: RGBA(0x2A_2F3A),
            foreground: RGBA(0xD6_DAE3),
            muted: RGBA(0x8B_93A5),
            faint: RGBA(0x5C_6475),
            accent: RGBA(0x6F_B1FA),
            cursor: RGBA(0x6F_B1FA),
            selection: RGBA(0x33_5588),
            warning: RGBA(0xE5_C07B),
            good: RGBA(0x8F_CC7A),
            ansi: table)
    }()

    /// `packed` is `tag << 24 | payload` — see the core's `pack_color`.
    /// tag 0 = terminal default, 1 = 256-colour index, 2 = 24-bit rgb.
    func resolve(_ packed: UInt32, isForeground: Bool) -> RGBA {
        switch packed >> 24 {
        case 0:
            return isForeground ? foreground : background
        case 1:
            let i = Int(packed & 0xFF)
            return i < ansi.count ? ansi[i] : foreground
        default:
            return RGBA(
                Double((packed >> 16) & 0xFF) / 255,
                Double((packed >> 8) & 0xFF) / 255,
                Double(packed & 0xFF) / 255)
        }
    }

    /// A default background needs no fill — the view is already that colour,
    /// and skipping it is most of the background work on a typical screen.
    func isDefaultBackground(_ packed: UInt32) -> Bool { packed == 0 }
}

/// Mirrors `CellFlags` in the core.
struct CellFlags: OptionSet {
    let rawValue: UInt16
    static let bold = CellFlags(rawValue: 1 << 0)
    static let dim = CellFlags(rawValue: 1 << 1)
    static let italic = CellFlags(rawValue: 1 << 2)
    static let underline = CellFlags(rawValue: 1 << 3)
    static let doubleUnderline = CellFlags(rawValue: 1 << 4)
    static let curlyUnderline = CellFlags(rawValue: 1 << 5)
    static let dottedUnderline = CellFlags(rawValue: 1 << 6)
    static let dashedUnderline = CellFlags(rawValue: 1 << 7)
    static let strikethrough = CellFlags(rawValue: 1 << 8)
    static let inverse = CellFlags(rawValue: 1 << 9)
    static let invisible = CellFlags(rawValue: 1 << 10)
    static let blink = CellFlags(rawValue: 1 << 11)
    static let wide = CellFlags(rawValue: 1 << 12)
    static let wideSpacer = CellFlags(rawValue: 1 << 13)

    static let anyUnderline: CellFlags = [
        .underline, .doubleUnderline, .curlyUnderline, .dottedUnderline, .dashedUnderline,
    ]
    /// The ones that pick a different font face, and so a different glyph.
    static let fontAffecting: CellFlags = [.bold, .italic]
}
