import SwiftUI

/// One terminal, with a status strip above it.
///
/// The strip is deliberately thin and quiet. What used to be there was a
/// performance HUD — frames per second, milliseconds per rebuild — which is
/// exactly the sort of thing that belongs behind a debug flag rather than in
/// front of somebody trying to read a build log.
struct TerminalScreen: View {
    @ObservedObject var workspace: Workspace
    @ObservedObject var session: LiveSession
    let onOpenURL: (URL) -> Void

    var body: some View {
        VStack(spacing: 0) {
            statusStrip
            Divider().overlay(Design.theme.border.color)
            ZStack(alignment: .bottom) {
                TerminalPane(
                    session: session,
                    theme: Design.theme,
                    onOpenURL: onOpenURL,
                    onNewSession: {
                        Task { await workspace.newTerminal([], cols: 80, rows: 24) }
                    },
                    onCloseSession: {
                        Task { await workspace.closeTerminal(session.id) }
                    },
                    onPickSession: { workspace.selectSession(at: $0) }
                )
                // The keyboard is handled inside the pane, in UIKit, where the
                // animation curve and the actual overlap are both knowable.
                // Letting SwiftUI also inset for it would move the terminal
                // twice.
                .ignoresSafeArea(.keyboard, edges: .bottom)

                // Reading history while a build scrolls past underneath is the
                // normal case, not an edge one, and the way back should not be
                // "drag until it stops".
                if session.scrolledBack {
                    Button {
                        session.engine.scrollToBottom()
                    } label: {
                        Label("Jump to latest", systemImage: "arrow.down.to.line")
                            .font(Design.text(13, .medium))
                            .foregroundStyle(Design.theme.background.color)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(Capsule().fill(Design.theme.accent.color))
                    }
                    .padding(.bottom, 18)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(.easeOut(duration: 0.18), value: session.scrolledBack)
        }
        .background(Design.theme.background.color)
        .onChange(of: session.attention?.body) { _, body in
            guard body != nil else { return }
            Haptics.attention()
        }
    }

    private var statusStrip: some View {
        HStack(spacing: 10) {
            Text(session.title ?? label)
                .font(Design.mono(12, .medium))
                .foregroundStyle(Design.theme.foreground.color)
                .lineLimit(1)

            if let box = workspace.box {
                Text(box.hostname)
                    .font(Design.mono(11))
                    .foregroundStyle(Design.theme.faint.color)
                    .lineLimit(1)
                    .truncationMode(.head)
            }

            Spacer(minLength: 8)

            connectionPill
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(Design.theme.surface.color)
    }

    private var label: String {
        workspace.sessions.first { $0.id == session.id }?.label ?? session.id
    }

    private var connectionPill: some View {
        let state = session.state
        let tint: Color =
            switch state {
            case .attached, .resynced: Design.theme.good.color
            case .connecting, .waiting: Design.theme.warning.color
            case .ended: Design.theme.muted.color
            case .idle: Design.theme.faint.color
            }
        let icon: String =
            switch state {
            case .attached, .resynced: "bolt.fill"
            case .connecting, .waiting: "arrow.triangle.2.circlepath"
            case .ended: "xmark"
            case .idle: "pause"
            }
        return Pill(text: state.label, tint: tint, icon: icon)
    }
}
