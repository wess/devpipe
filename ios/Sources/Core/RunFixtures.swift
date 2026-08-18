import Foundation

/// A fleet that needs no network.
///
/// The terminal has had `--fixture` since the renderer was written, for exactly
/// this reason: a screen you cannot see is a screen you cannot design. The runs
/// screens need it more, not less — they depend on a companion running on a box
/// somebody is paying for, in states (an agent blocked on a question, four runs
/// racing the same task) that are hard to arrange on purpose and impossible to
/// arrange twice.
///
/// Reachable with `--runs-fixture`. Nothing in it is reachable otherwise: with
/// the flag absent this is `nil` everywhere and every screen goes to the
/// control plane as usual.
struct RunFixtures {
    let user: Control.User
    let boxes: [Control.Box]
    let sessions: [Control.RemoteSession]
    let projects: [Asylum.Project]
    let tasks: [Asylum.Task]
    let runs: [Asylum.Run]
    let inbox: [Asylum.Note]

    static func fromLaunchArgs() -> RunFixtures? {
        guard ProcessInfo.processInfo.arguments.contains("--runs-fixture") else { return nil }
        return .demo
    }

    /// Deliberately not a happy path. One task is finished, one is mid-flight
    /// with three agents on it, and one is blocked on a question — which is the
    /// state the whole product exists to surface, and the one a screenshot of a
    /// green fleet never shows you.
    static let demo = RunFixtures(
        user: Control.User(
            id: 1, email: "you@example.com", username: "you", name: "You", is_owner: true),
        boxes: [
            Control.Box(
                id: 1, name: "amber", hostname: "amber.devpipe.com", status: "ready",
                status_detail: "", ip: "203.0.113.7",
                tools: ["claude-code", "codex", "asylum"], workspace_id: 1)
        ],
        sessions: [
            Control.RemoteSession(
                id: "s1", argv: ["bash"], cols: 100, rows: 30, title: "bash", alive: true),
            Control.RemoteSession(
                id: "s2", argv: ["claude"], cols: 100, rows: 30, title: "claude — devpipe",
                alive: true),
        ],
        projects: [
            Asylum.Project(id: 1, name: "devpipe", pinned: true),
            Asylum.Project(id: 2, name: "asylum", pinned: false),
            Asylum.Project(id: 3, name: "inkling", pinned: false),
        ],
        tasks: [
            Asylum.Task(id: 11, title: "Runs, not terminals, on the phone", status: "running"),
            Asylum.Task(id: 12, title: "Companion through the control plane", status: "blocked"),
            Asylum.Task(id: 13, title: "Glyph atlas eviction under memory pressure", status: "done"),
            Asylum.Task(id: 14, title: "Reclaim sleeps a box mid-build", status: "queued"),
        ],
        runs: [
            Asylum.Run(
                id: 101, agent: "claude", branch: "run/phone-shell-a", status: "running",
                activity: "Editing ios/Sources/UI/PhoneShell.swift"),
            Asylum.Run(
                id: 102, agent: "codex", branch: "run/phone-shell-b", status: "blocked",
                activity: "Asking: replace the split view on iPad too?"),
            Asylum.Run(
                id: 103, agent: "gemini", branch: "run/phone-shell-c", status: "running",
                activity: "Running checks — swift build"),
            Asylum.Run(
                id: 104, agent: "claude", branch: "run/phone-shell-d", status: "failed",
                activity: "swiftc: 3 errors in TerminalScreen.swift"),
        ],
        inbox: [
            Asylum.Note(
                id: 201, kind: "question", title: "codex is waiting on you",
                body: "Replace the split view on iPad too, or keep it?", read: false),
            Asylum.Note(
                id: 202, kind: "run", title: "claude finished run/phone-shell-a",
                body: "14 files changed, checks passed.", read: false),
            Asylum.Note(
                id: 203, kind: "run", title: "gemini opened run/phone-shell-c", body: "",
                read: true),
        ])
}
