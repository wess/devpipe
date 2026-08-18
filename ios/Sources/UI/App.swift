import SafariServices
import SwiftUI
import UIKit

@main
struct DevpipeApp: App {
    @Environment(\.scenePhase) private var phase
    @StateObject private var workspace = Workspace()

    init() {
        NotificationPresenter.shared.install()
    }

    var body: some Scene {
        WindowGroup {
            RootView(workspace: workspace)
                .preferredColorScheme(.dark)
                .tint(Design.theme.accent.color)
        }
        .onChange(of: phase) { _, new in
            // Nothing to poll for while the app is not on screen, and a
            // suspended app that wakes with a queued timer immediately does
            // work nobody asked for.
            switch new {
            case .active: workspace.startPolling()
            default: workspace.stopPolling()
            }
        }
    }
}

struct RootView: View {
    @ObservedObject var workspace: Workspace

    /// `--fixture <name>` and `--host <addr>` both short-circuit everything:
    /// no control plane, no account, just the terminal and a stream — canned
    /// for the render harness, or a real pty on a daemon for everything else.
    private let fixture = Fixtures.fromLaunchArgs()
    private let daemon = DaemonConfig.fromLaunchArgs()

    /// Which shell, and it is a question about the window rather than about the
    /// device. An iPad in Slide Over is compact, and a split view in a column
    /// that narrow collapses to a stack whose root is the sidebar — so it gets
    /// the phone's tabs, which is the right answer for the width it has.
    @Environment(\.horizontalSizeClass) private var width

    var body: some View {
        Group {
            if fixture != nil || daemon != nil {
                Harness(source: fixture, daemon: daemon)
            } else if workspace.loading {
                VStack(spacing: 14) {
                    ProgressView().tint(Design.theme.accent.color)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if workspace.user == nil {
                Gate(workspace: workspace)
            } else if width == .compact {
                PhoneShell(workspace: workspace)
            } else {
                PadShell(workspace: workspace)
            }
        }
        .background(Design.theme.background.color.ignoresSafeArea())
        .task {
            await workspace.restore()
            // A restored session, rather than merely a user on screen. The
            // fixture harness has the second without the first, and asking a
            // canned fleet for permission to notify puts a system alert over
            // every screen it exists to show.
            if Control.token != nil, workspace.user != nil { Notifier.requestPermission() }
            workspace.startPolling()
        }
    }
}

/// The build log, because a spinner for three minutes is indistinguishable
/// from a box that has died. The control plane has streamed this from the
/// start; only this client was not reading it.
struct BuildingPane: View {
    @ObservedObject var workspace: Workspace
    let box: Control.Box

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                ProgressView().controlSize(.small).tint(Design.theme.warning.color)
                Text(box.status_detail.isEmpty ? box.status : box.status_detail)
                    .font(Design.mono(13, .medium))
                    .foregroundStyle(Design.theme.warning.color)
                Spacer()
                Pill(text: box.name, tint: Design.theme.muted.color, icon: "shippingbox")
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .background(Design.theme.surface.color)

            Divider().overlay(Design.theme.border.color)

            ScrollViewReader { scroller in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(workspace.buildLog) { line in
                            Text(line.line)
                                .font(Design.mono(11.5))
                                .foregroundStyle(color(for: line.line))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(line.id)
                        }
                    }
                    .padding(18)
                }
                .onChange(of: workspace.buildLog.count) { _, _ in
                    // Follow the tail: the interesting line is always the last.
                    guard let last = workspace.buildLog.last?.id else { return }
                    withAnimation(.easeOut(duration: 0.2)) {
                        scroller.scrollTo(last, anchor: .bottom)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Design.theme.background.color)
    }

    private func color(for line: String) -> Color {
        if line.hasPrefix("[!!]") { return Design.theme.warning.color }
        if line.hasPrefix("[ok]") { return Design.theme.good.color }
        if line.hasPrefix("==") { return Design.theme.accent.color }
        return Design.theme.muted.color
    }
}

/// Wraps `SFSafariViewController`, which keeps the browser inside the app while
/// still running in Safari's own session — so an existing claude.com login is
/// already there and the user is not asked to sign in twice.
struct SafariSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.preferredControlTintColor = Design.theme.accent.uiColor
        controller.preferredBarTintColor = Design.theme.background.uiColor
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

/// So a `URL` can drive `.sheet(item:)` directly.
extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}
