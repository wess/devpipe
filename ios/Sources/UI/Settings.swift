import SwiftUI

/// What the app remembers between launches.
///
/// Small on purpose. A terminal has very few settings worth having, and the
/// ones people actually reach for are how big the text is and whether the
/// thing buzzes — both of which were previously constants compiled into the
/// binary, so pinching to a comfortable size lasted until you switched
/// sessions.
@MainActor
final class Settings: ObservableObject {
    static let shared = Settings()

    @Published var fontSize: CGFloat {
        didSet { store.set(Double(fontSize), forKey: "fontSize") }
    }
    /// Scrollback per session. Every session pays for this in memory, which is
    /// why it is a setting rather than a number picked once.
    @Published var scrollback: Int {
        didSet { store.set(scrollback, forKey: "scrollback") }
    }
    @Published var haptics: Bool {
        didSet { store.set(haptics, forKey: "haptics") }
    }
    /// A bell is a notification on a device that lives on a desk near other
    /// people, so it defaults to a tap rather than a sound.
    @Published var bellHaptic: Bool {
        didSet { store.set(bellHaptic, forKey: "bellHaptic") }
    }

    private let store = UserDefaults.standard

    private init() {
        store.register(defaults: [
            "fontSize": 13.0,
            "scrollback": 10_000,
            "haptics": true,
            "bellHaptic": true,
        ])
        fontSize = CGFloat(store.double(forKey: "fontSize"))
        scrollback = store.integer(forKey: "scrollback")
        haptics = store.bool(forKey: "haptics")
        bellHaptic = store.bool(forKey: "bellHaptic")
    }

    static let fontRange: ClosedRange<CGFloat> = 9...28
    static let scrollbackChoices = [2_000, 10_000, 50_000, 200_000]
}

struct SettingsSheet: View {
    @ObservedObject var settings = Settings.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Text") {
                    HStack {
                        Text("Size")
                        Spacer()
                        Text("\(Int(settings.fontSize)) pt")
                            .font(Design.mono(13))
                            .foregroundStyle(Design.theme.muted.color)
                    }
                    Slider(
                        value: $settings.fontSize,
                        in: Settings.fontRange,
                        step: 1)
                    // A sample at the real size, because "13 pt" means nothing
                    // until you see what it looks like on this screen at arm's
                    // length.
                    Text("$ claude --resume  # the quick brown fox")
                        .font(.system(size: settings.fontSize, design: .monospaced))
                        .foregroundStyle(Design.theme.foreground.color)
                        .lineLimit(1)
                        .minimumScaleFactor(0.4)
                    Text("Pinch the terminal to change this without coming here.")
                        .font(Design.text(12))
                        .foregroundStyle(Design.theme.muted.color)
                }

                Section("History") {
                    Picker("Scrollback", selection: $settings.scrollback) {
                        ForEach(Settings.scrollbackChoices, id: \.self) { lines in
                            Text("\(lines / 1000)k lines").tag(lines)
                        }
                    }
                    Text(
                        "Kept per terminal, on this device. Takes effect on terminals opened after now."
                    )
                    .font(Design.text(12))
                    .foregroundStyle(Design.theme.muted.color)
                }

                Section("Feedback") {
                    Toggle("Haptics", isOn: $settings.haptics)
                    Toggle("Buzz on bell", isOn: $settings.bellHaptic)
                    Text(
                        "A bell is usually an agent asking for you. A sound would be wrong on a device that lives on a desk near other people."
                    )
                    .font(Design.text(12))
                    .foregroundStyle(Design.theme.muted.color)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }
}

/// Haptics, in one place, so the setting is honoured everywhere rather than in
/// whichever call sites remembered to check it.
enum Haptics {
    @MainActor
    static func tap(_ style: UIImpactFeedbackGenerator.FeedbackStyle = .light) {
        guard Settings.shared.haptics else { return }
        UIImpactFeedbackGenerator(style: style).impactOccurred()
    }

    @MainActor
    static func selection() {
        guard Settings.shared.haptics else { return }
        UISelectionFeedbackGenerator().selectionChanged()
    }

    @MainActor
    static func bell() {
        guard Settings.shared.haptics, Settings.shared.bellHaptic else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    @MainActor
    static func attention() {
        guard Settings.shared.haptics else { return }
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
}
