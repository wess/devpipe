import Foundation
import SwiftUI

/// The work on a box: projects, their tasks, and the runs against one.
///
/// Separate from `Workspace` on purpose. `Workspace` is the control plane —
/// accounts, boxes, terminals — and it changes a few times a minute. This
/// changes every second while an agent is working, and folding the two together
/// would mean every run's activity line re-evaluates the box picker.
@MainActor
final class RunsModel: ObservableObject {
    @Published private(set) var projects: [Asylum.Project] = []
    @Published private(set) var tasks: [Asylum.Task] = []
    @Published private(set) var runs: [Asylum.Run] = []
    @Published private(set) var inbox: [Asylum.Note] = []
    @Published private(set) var unread = 0

    @Published private(set) var project: Int?
    @Published private(set) var task: Int?

    /// Before the first answer, so a screen with nothing on it does not claim
    /// there is nothing to show.
    @Published private(set) var loading = true

    /// Whether the companion answered at all.
    ///
    /// Deliberately three-valued. A box with no projects and a box that is not
    /// answering look identical in an empty list, and only one of them is worth
    /// telling somebody about; `nil` is "not asked yet", which is neither.
    @Published private(set) var reachable: Bool?

    private var companion: Companion?
    private var cursor = 0
    private var poll: Task<Void, Never>?
    private let canned = RunFixtures.fromLaunchArgs()

    var current: Asylum.Task? { tasks.first { $0.id == task } }

    /// Something is mid-flight or asking for a person.
    var busy: Bool {
        runs.contains { Asylum.Tone.of($0.status).busy }
    }

    // MARK: - which box

    /// Point at a box, or at none.
    ///
    /// Called when the selection changes and when a box wakes. Pointing at the
    /// same box twice is a no-op rather than a reload: the poller is already
    /// following it, and re-fetching would blank a screen somebody is reading.
    func point(at box: Int?, control: Control) {
        if let box {
            guard companion?.box != box else { return }
            companion = Companion(control: control, box: box)
        } else {
            guard companion != nil else { return }
            companion = nil
        }
        cursor = 0
        projects = []
        tasks = []
        runs = []
        project = nil
        task = nil
        loading = true
        reachable = nil
        Task { await load() }
    }

    // MARK: - selection

    func select(project id: Int) {
        guard project != id else { return }
        project = id
        tasks = []
        runs = []
        task = nil
        Task { await loadTasks() }
    }

    func select(task id: Int?) {
        guard task != id else { return }
        task = id
        runs = []
        guard id != nil else { return }
        Task { await loadRuns() }
    }

    // MARK: - loading

    func load() async {
        await loadProjects()
        await loadInbox()
        loading = false
    }

    private func loadProjects() async {
        guard let companion else {
            if canned != nil { adoptCanned() }
            return
        }
        do {
            let list = try await companion.projects()
            reachable = true
            projects = list
            // Pinned first, but only to pick an opening selection — the list
            // keeps the order the box gave it.
            if project == nil || !list.contains(where: { $0.id == project }) {
                let opening = list.sorted { ($0.pinned ? 1 : 0) > ($1.pinned ? 1 : 0) }.first
                project = opening?.id
                if project != nil { await loadTasks() }
            }
        } catch {
            reachable = false
        }
    }

    private func loadTasks() async {
        guard let companion, let project else { return }
        do {
            let list = try await companion.tasks(project: project)
            tasks = list
            if task == nil || !list.contains(where: { $0.id == task }) {
                task = list.first?.id
                if task != nil { await loadRuns() }
            }
        } catch {
            tasks = []
        }
    }

    private func loadRuns() async {
        guard let task else { return }
        guard let companion else {
            // The same four runs for whichever task is open. A harness that
            // empties the screen when you pick the second task is a harness you
            // cannot lay out the second task with.
            if let canned { runs = canned.runs }
            return
        }
        runs = (try? await companion.runs(task: task)) ?? []
    }

    private func loadInbox() async {
        guard let companion else { return }
        // Leave the last known inbox up on a failure. A count that blanks on a
        // dropped packet reads as "everything was handled", which is the
        // opposite of true.
        guard let out = try? await companion.inbox() else { return }
        unread = out.unread
        inbox = out.items
    }

    /// Send a message to the task's runs.
    func followUp(_ message: String) async throws {
        guard let companion, let task else { return }
        try await companion.followUp(task: task, message: message)
        await loadInbox()
    }

    func refresh() async {
        await loadInbox()
        await loadTasks()
        await loadRuns()
    }

    // MARK: - the feed

    /// Follow the event log, and refresh what is on screen when something
    /// moved.
    ///
    /// The alternative — re-fetching projects, tasks and runs on a timer — is
    /// three requests per tick against a SQLite file on somebody's box, to
    /// learn nothing on the overwhelming majority of ticks. The log exists so
    /// one cheap request can answer "has anything happened", and the tables are
    /// read only when the answer is yes.
    ///
    /// The interval is not fixed, because "how stale may this be" is not one
    /// question. While an agent is working, a second is the difference between
    /// watching something happen and reading a report about it. While
    /// everything is settled, a second is a request per second, forever, to be
    /// told nothing again — on hardware somebody is paying for by the hour.
    ///
    /// Nothing runs while the app is off screen at all: `scenePhase` stops it,
    /// and it catches up in one tick on the way back. That last part is what
    /// makes it feel live in practice, because the common case is not staring
    /// at the screen, it is glancing back at it.
    ///
    /// This should be a push, and the shape of the endpoint says so: the
    /// companion already keeps a cursor-addressed append-only log, which is
    /// exactly what Server-Sent Events resume against with `Last-Event-ID`.
    func startPolling() {
        guard poll == nil else { return }
        poll = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.tick()
                guard !Task.isCancelled else { return }
                try? await Task.sleep(for: .seconds(self.busy ? 1 : 10))
            }
        }
    }

    func stopPolling() {
        poll?.cancel()
        poll = nil
    }

    private func tick() async {
        guard let companion else { return }
        do {
            let feed = try await companion.events(since: cursor)
            cursor = feed.cursor
            reachable = true
            if !feed.items.isEmpty { await refresh() }
        } catch {
            // Transient. The screen already says whether the box is reachable;
            // a failed poll should not clear what somebody is reading.
        }
    }

    // MARK: - fixtures

    /// `--runs-fixture` fills the screens from nothing at all, so the phone
    /// layouts can be worked on without an account, a box, or a companion.
    private func adoptCanned() {
        guard let canned else { return }
        projects = canned.projects
        project = canned.projects.first?.id
        tasks = canned.tasks
        task = canned.tasks.first?.id
        runs = canned.runs
        inbox = canned.inbox
        unread = canned.inbox.filter { !$0.read }.count
        reachable = true
    }
}
