import CoreGraphics
import UIKit

/// Resolves the `Color` tags the core hands over into actual RGB. The core
/// deliberately does not bake a theme in — it ships `Default`/`Indexed`/`Rgb`
/// and the client decides what those mean, which is what lets the theme change
/// without touching the emulator.
enum Palette {
    static let background = CGColor(red: 0.071, green: 0.078, blue: 0.098, alpha: 1)
    static let foreground = CGColor(red: 0.839, green: 0.855, blue: 0.886, alpha: 1)
    static let cursor = CGColor(red: 0.435, green: 0.694, blue: 0.984, alpha: 1)

    /// xterm's 256: 16 named, a 6×6×6 cube, then 24 greys.
    private static let table: [CGColor] = {
        var out: [CGColor] = []
        out.reserveCapacity(256)

        let named: [(Double, Double, Double)] = [
            (0.13, 0.14, 0.17), (0.94, 0.38, 0.42), (0.56, 0.80, 0.47), (0.90, 0.75, 0.42),
            (0.44, 0.69, 0.98), (0.78, 0.57, 0.94), (0.42, 0.80, 0.80), (0.84, 0.85, 0.89),
            (0.35, 0.38, 0.44), (0.98, 0.51, 0.55), (0.66, 0.88, 0.57), (0.98, 0.85, 0.52),
            (0.56, 0.78, 1.00), (0.87, 0.68, 0.98), (0.53, 0.89, 0.89), (0.98, 0.99, 1.00),
        ]
        for (r, g, b) in named { out.append(CGColor(red: r, green: g, blue: b, alpha: 1)) }

        let steps: [Double] = [0, 95, 135, 175, 215, 255].map { $0 / 255.0 }
        for r in 0..<6 {
            for g in 0..<6 {
                for b in 0..<6 {
                    out.append(CGColor(red: steps[r], green: steps[g], blue: steps[b], alpha: 1))
                }
            }
        }
        for i in 0..<24 {
            let v = (8.0 + Double(i) * 10.0) / 255.0
            out.append(CGColor(red: v, green: v, blue: v, alpha: 1))
        }
        return out
    }()

    /// `packed` is `tag << 24 | payload` — see the core's `pack_color`.
    static func resolve(_ packed: UInt32, isForeground: Bool) -> CGColor {
        switch packed >> 24 {
        case 0:
            return isForeground ? foreground : background
        case 1:
            return table[Int(packed & 0xFF)]
        default:
            let r = Double((packed >> 16) & 0xFF) / 255.0
            let g = Double((packed >> 8) & 0xFF) / 255.0
            let b = Double(packed & 0xFF) / 255.0
            return CGColor(red: r, green: g, blue: b, alpha: 1)
        }
    }

    /// A default background needs no fill — the view is already that color, and
    /// skipping it is most of the background work on a typical screen.
    static func isDefaultBackground(_ packed: UInt32) -> Bool { packed == 0 }
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
}
