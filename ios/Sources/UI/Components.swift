import SwiftUI

extension RGBA {
    var color: Color { Color(cgColor) }
}

/// The one theme, reachable without threading it through every initialiser.
/// A second theme is a settings screen away and this is the seam it goes
/// through; a `@Environment` key for a value that never changes would be
/// ceremony.
enum Design {
    static let theme = Theme.dark

    /// Monospace for anything that names a machine, a session or a path —
    /// which is nearly everything in the chrome — and the system face for
    /// prose. Mixing them deliberately is what stops the sidebar reading as a
    /// second terminal.
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }

    static func text(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }
}

/// State as a colour, with a shape for the cases where colour alone will not
/// do it — a box being built and a box that is awake are green and orange, and
/// telling those apart is not something to leave to hue alone.
struct StatusDot: View {
    enum Kind {
        case live, busy, asleep, gone

        var color: Color {
            switch self {
            case .live: return Design.theme.good.color
            case .busy: return Design.theme.warning.color
            case .asleep: return Design.theme.faint.color
            case .gone: return Design.theme.muted.color
            }
        }
    }

    let kind: Kind
    var pulses = false
    @State private var on = false

    var body: some View {
        Circle()
            .fill(kind.color)
            .frame(width: 7, height: 7)
            .opacity(pulses && on ? 0.35 : 1)
            .animation(
                pulses
                    ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true) : .default,
                value: on
            )
            .onAppear { if pulses { on = true } }
    }
}

struct SectionHeader: View {
    let title: String

    var body: some View {
        Text(title.uppercased())
            .font(Design.mono(10, .semibold))
            .kerning(0.8)
            .foregroundStyle(Design.theme.faint.color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.top, 16)
            .padding(.bottom, 6)
    }
}

/// A small labelled capsule: connection state, a region, a price.
struct Pill: View {
    let text: String
    var tint: Color = Design.theme.muted.color
    var icon: String?

    var body: some View {
        HStack(spacing: 4) {
            if let icon { Image(systemName: icon).font(.system(size: 9, weight: .semibold)) }
            Text(text)
        }
        .font(Design.mono(10, .medium))
        .foregroundStyle(tint)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(
            Capsule().fill(tint.opacity(0.12))
        )
        .overlay(
            Capsule().strokeBorder(tint.opacity(0.22), lineWidth: 0.5)
        )
    }
}

/// An `HStack` that wraps.
///
/// For rows of pills whose count and width are both the server's to decide — a
/// box built with two tools and one built with nine want the same code. An
/// `HStack` clips the ninth and a `LazyVGrid` gives every pill the width of the
/// longest, which for names between three and twelve characters looks like a
/// table nobody meant to draw.
struct FlowRow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += line + spacing
                line = 0
            }
            x += size.width + spacing
            line = max(line, size.height)
        }
        return CGSize(width: proposal.width ?? x, height: y + line)
    }

    func placeSubviews(
        in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Void
    ) {
        var x = bounds.minX
        var y = bounds.minY
        var line: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += line + spacing
                line = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}

/// The app's one prominent button. Everything else is plain text, so this
/// carries weight by being the only thing that does.
struct FilledButtonStyle: ButtonStyle {
    var tint: Color = Design.theme.accent.color
    var wide = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Design.text(15, .semibold))
            .foregroundStyle(Design.theme.background.color)
            .padding(.horizontal, 18)
            .padding(.vertical, 11)
            .frame(maxWidth: wide ? .infinity : nil)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(tint.opacity(configuration.isPressed ? 0.75 : 1))
            )
            .contentShape(Rectangle())
    }
}

struct QuietButtonStyle: ButtonStyle {
    var tint: Color = Design.theme.foreground.color
    var wide = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Design.mono(12.5))
            .foregroundStyle(tint)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: wide ? .infinity : nil, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(Design.theme.surfaceRaised.color.opacity(configuration.isPressed ? 1 : 0.6))
            )
            .contentShape(Rectangle())
    }
}

/// A dark field that matches the rest of the chrome. `.roundedBorder` renders
/// as a light-mode box on a dark background, which is what made the sign-in
/// screen look like a debug harness.
struct FieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .font(Design.text(15))
            .foregroundStyle(Design.theme.foreground.color)
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(Design.theme.surfaceRaised.color)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .strokeBorder(Design.theme.border.color, lineWidth: 1)
            )
    }
}

/// What a pane says when there is nothing in it. Four different situations
/// used to collapse into one line of grey text, and the one that mattered most
/// — a box asleep, which is where every box ends up — offered nothing to do
/// about it.
struct EmptyPane<Actions: View>: View {
    let icon: String
    let title: String
    var detail: String?
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(Design.theme.faint.color)
            Text(title)
                .font(Design.text(16, .medium))
                .foregroundStyle(Design.theme.foreground.color)
            if let detail {
                Text(detail)
                    .font(Design.text(13))
                    .foregroundStyle(Design.theme.muted.color)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
            }
            actions()
                .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
    }
}
