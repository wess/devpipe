import SwiftUI

/// The pieces both idioms are built from.
///
/// A run reads the same on a phone and on an iPad — the same words, the same
/// colour for the same state, the same three lines in the same order. What
/// differs between the two is only how many of them fit beside each other,
/// which is a job for the shells rather than for this file.

extension Asylum.Tone {
    var color: Color {
        switch self {
        case .ok: return Design.theme.good.color
        case .live: return Design.theme.accent.color
        case .warn: return Design.theme.warning.color
        case .bad: return Design.theme.ansi[1].color
        case .idle: return Design.theme.muted.color
        }
    }

    /// Colour alone will not do it. "Running" and "blocked" are the two states
    /// anybody actually looks for, they are both mid-flight, and telling them
    /// apart is not something to leave to hue.
    var icon: String {
        switch self {
        case .ok: return "checkmark.circle.fill"
        case .live: return "circle.dotted"
        case .warn: return "hand.raised.fill"
        case .bad: return "exclamationmark.triangle.fill"
        case .idle: return "circle"
        }
    }
}

/// A status word, in its own colour, with its own shape.
///
/// Whatever the companion said, verbatim. An unknown status renders as a
/// neutral pill with its own name in it rather than being mapped onto the
/// nearest thing this client happens to know about.
struct StatusPill: View {
    let status: String
    var large = false

    private var tone: Asylum.Tone { Asylum.Tone.of(status) }

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: tone.icon)
                .font(.system(size: large ? 10 : 8.5, weight: .bold))
                // The one state that earns motion, because it is the only one
                // asking for a person.
                .symbolEffect(.pulse, options: .repeating, isActive: tone == .warn)
            Text(status)
        }
        .font(Design.mono(large ? 11 : 10, .medium))
        .foregroundStyle(tone.color)
        .padding(.horizontal, large ? 9 : 7)
        .padding(.vertical, large ? 4 : 3)
        .background(Capsule().fill(tone.color.opacity(0.12)))
        .overlay(Capsule().strokeBorder(tone.color.opacity(0.25), lineWidth: 0.5))
    }
}

/// One agent's attempt.
///
/// The branch is in monospace and the activity is not, deliberately: one is a
/// name you might type and the other is a sentence somebody wrote about what is
/// happening. Setting both in the same face is what made an earlier version of
/// this read as log output.
struct RunCard: View {
    let run: Asylum.Run

    private var tone: Asylum.Tone { Asylum.Tone.of(run.status) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(run.agent)
                    .font(Design.mono(13, .semibold))
                    .foregroundStyle(Design.theme.foreground.color)
                Spacer(minLength: 6)
                StatusPill(status: run.status)
            }

            HStack(spacing: 5) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 9.5))
                Text(run.branch)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .font(Design.mono(11))
            .foregroundStyle(Design.theme.faint.color)

            // The reason this screen exists. A spinner cannot tell a thinking
            // agent from one blocked on a question.
            if let activity = run.activity, !activity.isEmpty {
                Text(activity)
                    .font(Design.text(13))
                    .foregroundStyle(
                        tone == .warn ? Design.theme.warning.color : Design.theme.muted.color
                    )
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Design.theme.surface.color)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                // A blocked run is outlined in its own colour. It is the one
                // card on the screen that wants finding without reading.
                .strokeBorder(
                    tone == .warn ? Design.theme.warning.color.opacity(0.5)
                        : Design.theme.border.color, lineWidth: 1)
        )
    }
}

/// A task in a list: what was asked for, and how it is going.
///
/// A card rather than a plain row. Titles here are sentences and they wrap to
/// two lines about half the time, so rows separated by nothing but whitespace
/// run together — the second line of one task and the first line of the next
/// read as one paragraph.
struct TaskRow: View {
    let task: Asylum.Task
    var selected = false
    /// Whether tapping goes somewhere. The phone pushes a screen and says so
    /// with a chevron; the iPad's list column selects in place, where a chevron
    /// would point at a column that is already open.
    var pushes = false

    var body: some View {
        HStack(spacing: 10) {
            Text(task.title)
                .font(Design.text(15))
                .foregroundStyle(Design.theme.foreground.color)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            StatusPill(status: task.status)
            if pushes {
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Design.theme.faint.color)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .background(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(selected ? Design.theme.accent.color.opacity(0.14) : Design.theme.surface.color)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(
                    selected ? Design.theme.accent.color.opacity(0.45) : Design.theme.border.color,
                    lineWidth: 1)
        )
        .contentShape(Rectangle())
    }
}

/// One line of the inbox.
///
/// Unread is a dot rather than a bold row: these arrive in bursts when a fleet
/// wakes up, and a screen where nine rows out of ten are emphasised has
/// emphasised nothing.
struct NoteRow: View {
    let note: Asylum.Note

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(note.read ? Color.clear : Design.theme.accent.color)
                .frame(width: 7, height: 7)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                Text(note.title)
                    .font(Design.text(14, note.read ? .regular : .medium))
                    .foregroundStyle(Design.theme.foreground.color)
                    .fixedSize(horizontal: false, vertical: true)
                if !note.body.isEmpty {
                    Text(note.body)
                        .font(Design.text(12.5))
                        .foregroundStyle(Design.theme.muted.color)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }
}

/// Say something to a task's runs.
///
/// Sits at the bottom of whatever is showing runs, on both idioms. It is one
/// line until it is not: a follow-up is usually a sentence, and a composer that
/// opens three lines tall for "yes, go ahead" wastes the part of the screen the
/// runs are on.
struct Composer: View {
    @ObservedObject var runs: RunsModel
    @State private var message = ""
    @State private var sending = false
    @State private var said: String?
    @FocusState private var writing: Bool

    var body: some View {
        VStack(spacing: 6) {
            if let said {
                Text(said)
                    .font(Design.text(12))
                    .foregroundStyle(Design.theme.good.color)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Say something to this task's runs…", text: $message, axis: .vertical)
                    .lineLimit(1...5)
                    .font(Design.text(15))
                    .foregroundStyle(Design.theme.foreground.color)
                    .focused($writing)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(Design.theme.surfaceRaised.color)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .strokeBorder(Design.theme.border.color, lineWidth: 1)
                    )

                Button {
                    Task { await send() }
                } label: {
                    Image(systemName: sending ? "ellipsis" : "arrow.up")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(Design.theme.background.color)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(Design.theme.accent.color))
                }
                .disabled(sending || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .opacity(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) {
            Rectangle().fill(Design.theme.border.color).frame(height: 0.5)
        }
    }

    private func send() async {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        sending = true
        do {
            try await runs.followUp(text)
            message = ""
            writing = false
            // What actually happened, rather than "Sent". The companion writes
            // it to a queue and a run picks it up when it next drains one, so a
            // reply that does not appear for a minute is the system working.
            said = "Queued. It reaches the run when the box next drains the queue."
        } catch {
            said = error.localizedDescription
        }
        sending = false
        try? await Task.sleep(for: .seconds(4))
        said = nil
    }
}

/// What a runs screen says when it has nothing on it.
///
/// The distinction this exists to keep is between a box with no work on it and
/// a box that is not answering. They look identical in an empty list and only
/// one of them is worth telling somebody about.
struct RunsEmpty: View {
    @ObservedObject var runs: RunsModel
    let hasBox: Bool

    var body: some View {
        if runs.loading {
            ProgressView()
                .tint(Design.theme.accent.color)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if !hasBox {
            EmptyPane(
                icon: "shippingbox",
                title: "No box is awake",
                detail: "Runs live on a box. Wake one, or make one, and its work shows up here."
            ) {}
        } else if runs.reachable == false {
            EmptyPane(
                icon: "antenna.radiowaves.left.and.right.slash",
                title: "The box is not answering",
                detail: "Its terminals may still work. This screen needs the companion, which runs alongside them."
            ) {}
        } else {
            EmptyPane(
                icon: "tray",
                title: "Nothing running",
                detail: "Dispatch a task from your machine and the attempts against it show up here."
            ) {}
        }
    }
}
