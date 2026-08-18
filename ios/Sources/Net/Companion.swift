import Foundation

/// Asylum's model, which is the product's model.
///
/// A project holds tasks, a task holds *runs*, and a run is one agent's attempt
/// in its own worktree on its own branch. This is the whole reason the app is
/// no longer a list of terminals: one task, many attempts, and a terminal is a
/// pane you open on a box when you want one.
///
/// Every shape here is transcribed from `crates/companion/src/router.rs` in the
/// Asylum repo rather than invented, and the web client's `asylum/api.ts` is
/// the same transcription in TypeScript. Nothing was designed for this file.
enum Asylum {
    /// A repository Asylum is watching. `pinned` sorts it, nothing more.
    struct Project: Codable, Identifiable, Hashable {
        let id: Int
        let name: String
        let pinned: Bool
    }

    /// A unit of intent — what somebody asked for, not what any one agent did
    /// about it.
    struct Task: Codable, Identifiable, Hashable {
        let id: Int
        let title: String
        let status: String
    }

    /// One agent's attempt at a task.
    ///
    /// `status` is the lifecycle — queued, running, done, failed. `activity` is
    /// the *semantic* state the agent reports, "waiting on review", "running
    /// checks", and it is the field this whole screen exists to show: a spinner
    /// cannot tell an agent that is thinking from one that has been blocked on
    /// a question for twenty minutes.
    struct Run: Codable, Identifiable, Hashable {
        let id: Int
        let agent: String
        let branch: String
        let status: String
        let activity: String?
    }

    /// Named `Note` rather than `Notification` so it cannot be confused with
    /// the local ones the app posts through `UNUserNotificationCenter` — these
    /// come off a box and have never been near the notification centre.
    struct Note: Codable, Identifiable, Hashable {
        let id: Int
        let kind: String
        let title: String
        let body: String
        let read: Bool
    }

    /// A line in the append-only log, which is how a client follows a fleet
    /// without polling five tables.
    struct Event: Codable, Identifiable, Equatable {
        let id: Int
        let kind: String
        let task: Int?
        let run: Int?
    }

    struct Feed: Codable {
        let cursor: Int
        let items: [Event]
    }

    struct Inbox: Codable {
        let unread: Int
        let items: [Note]
    }

    /// What a status word means, as a colour.
    ///
    /// Deliberately a lookup over a lowercased string rather than an enum with
    /// a case per status. Asylum's `RunStatus` gains variants faster than this
    /// client will be rebuilt, and an unknown status should render as a neutral
    /// pill with its own name in it — not crash, and not quietly claim to be
    /// "done".
    enum Tone {
        case ok, live, warn, bad, idle

        private static let table: [String: Tone] = [
            "done": .ok, "merged": .ok, "passed": .ok,
            "running": .live, "working": .live,
            "queued": .idle, "pending": .idle, "idle": .idle,
            "blocked": .warn, "waiting": .warn, "review": .warn,
            "failed": .bad, "error": .bad, "cancelled": .bad,
        ]

        static func of(_ status: String) -> Tone {
            table[status.lowercased()] ?? .idle
        }

        /// Worth watching closely. Anything mid-flight or asking for a person
        /// is a reason to poll fast; a settled fleet is not.
        var busy: Bool { self == .live || self == .warn }
    }
}

/// The companion, reached through the control plane.
///
/// Never straight at the box. The companion's bearer is a box credential and
/// the control plane is the only thing that holds one — the same arrangement
/// the terminal session list has always used, for the same reason. What the
/// app carries is an account session, and `/api/boxes/:id/companion/*` is where
/// the two meet.
struct Companion {
    let control: Control
    let box: Int

    private var base: String { "/api/boxes/\(box)/companion/api" }

    func projects() async throws -> [Asylum.Project] {
        try await control.send("GET", "\(base)/projects", as: [Asylum.Project].self)
    }

    func tasks(project: Int) async throws -> [Asylum.Task] {
        try await control.send("GET", "\(base)/projects/\(project)/tasks", as: [Asylum.Task].self)
    }

    func runs(task: Int) async throws -> [Asylum.Run] {
        try await control.send("GET", "\(base)/tasks/\(task)/runs", as: [Asylum.Run].self)
    }

    func inbox() async throws -> Asylum.Inbox {
        try await control.send("GET", "\(base)/notifications", as: Asylum.Inbox.self)
    }

    /// Everything that has happened since `cursor`.
    ///
    /// The returned cursor is what to pass next time — including when `items`
    /// is empty, because the companion answers with the cursor it was given and
    /// losing it means starting over.
    func events(since cursor: Int, limit: Int = 200) async throws -> Asylum.Feed {
        try await control.send(
            "GET", "\(base)/events?since=\(cursor)&limit=\(limit)", as: Asylum.Feed.self)
    }

    /// Say something to a task's runs.
    ///
    /// Queued rather than delivered: the companion writes it to the store and
    /// the thing draining that queue hands it to a live run. So a follow-up
    /// sent to an agent mid-thought is not lost, and one sent to a task with
    /// nothing running waits for the next attempt instead of failing.
    func followUp(task: Int, message: String) async throws {
        _ = try await control.send(
            "POST", "\(base)/tasks/\(task)/followup", body: ["message": message], as: Ack.self)
    }

    /// Whatever the companion answered, thrown away.
    ///
    /// A struct with no properties decodes any JSON object, which is what is
    /// wanted here: the acknowledgement's shape is Asylum's to change, and a
    /// client that fails to parse it would report a follow-up as lost when it
    /// had in fact been queued.
    private struct Ack: Codable {}
}
