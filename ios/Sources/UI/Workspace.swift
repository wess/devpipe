import Foundation
import SwiftUI

/// Everything the control plane knows, as the app sees it.
///
/// Deliberately the only `ObservableObject` the shell watches. The previous
/// version published render statistics from inside the draw call, so every
/// frame re-evaluated the whole view tree — sidebar, buttons and all — a
/// hundred and twenty times a second. Nothing here changes more than a few
/// times a minute.
@MainActor
final class Workspace: ObservableObject {
    @Published var user: Control.User?
    @Published var boxes: [Control.Box] = []
    @Published var selectedBox: Int?
    @Published var sessions: [Control.RemoteSession] = []
    @Published var selectedSession: String?
    @Published var connection: Control.Connection?
    @Published var error: String?
    @Published var loading = true

    /// What each tool is called and how it starts. Fetched, never hardcoded.
    @Published var catalog: [Control.Tool] = []
    @Published var sizes: [Control.Size] = []
    @Published var regions: [Control.Region] = []
    @Published var defaultTools: [String] = []

    /// The build log of the box being watched, oldest first.
    @Published var buildLog: [Control.BoxEvent] = []
    /// A wake or a build in flight, so the button can say so.
    @Published var busyBox: Int?

    let control = Control.fromLaunchArgs()
    let sessionStore = SessionStore()

    /// The work on the selected box, which is what the app is actually about.
    /// Kept beside this rather than inside it: the two move at completely
    /// different rates, and a run's activity line changing should not
    /// re-evaluate the box picker.
    let runs = RunsModel()

    /// `--runs-fixture`: a whole fleet, with no network behind it.
    private let canned = RunFixtures.fromLaunchArgs()

    private var logCursor = 0
    private var poll: Task<Void, Never>?
    /// Which box the current `connection` belongs to, so a refresh does not
    /// re-fetch a credential that has not changed. The old version asked for a
    /// fresh connection and a fresh session list on every poll — eight seconds
    /// apart, forever, for a value that changes when you switch boxes.
    private var connectedBox: Int?

    var box: Control.Box? { boxes.first { $0.id == selectedBox } }

    /// The agents actually on this box, each with the argv it is started by.
    ///
    /// Catalogue order, filtered by what the box was built with — the same rule
    /// the web client follows, from the same endpoint, so the two cannot drift
    /// on what a tool is called or how it starts.
    var agents: [Control.Tool] {
        guard let box else { return [] }
        return catalog.filter {
            $0.group == "agent" && $0.launch != nil && box.tools.contains($0.id)
        }
    }

    // MARK: - lifecycle

    func restore() async {
        if let canned {
            user = canned.user
            boxes = canned.boxes
            selectedBox = canned.boxes.first?.id
            sessions = canned.sessions
            selectedSession = canned.sessions.first?.id
            await runs.load()
            loading = false
            return
        }
        guard Control.token != nil else {
            loading = false
            return
        }
        do {
            user = try await control.me()
            await loadCatalog()
            await refreshBoxes()
        } catch {
            user = nil
        }
        loading = false
    }

    /// Once per sign-in. The catalogue changes when the product ships, not
    /// while somebody is looking at it.
    func loadCatalog() async {
        guard let out = try? await control.catalog() else { return }
        catalog = out.tools
        sizes = out.sizes
        regions = out.regions
        defaultTools = out.defaults
    }

    func signOut() async {
        stopPolling()
        sessionStore.dropAll()
        runs.point(at: nil, control: control)
        await control.signOut()
        user = nil
        boxes = []
        sessions = []
        connection = nil
        connectedBox = nil
        selectedBox = nil
        selectedSession = nil
    }

    // MARK: - boxes

    func refreshBoxes() async {
        do {
            let fetched = try await control.boxes()
            let changed = fetched != boxes
            boxes = fetched
            error = nil

            if selectedBox == nil || !fetched.contains(where: { $0.id == selectedBox }) {
                selectedBox = fetched.first(where: { $0.awake })?.id ?? fetched.first?.id
            }
            // The wake finished, so the button stops saying it is working.
            if let busy = busyBox, fetched.first(where: { $0.id == busy })?.awake == true {
                busyBox = nil
            }
            // Only when there is something new to open. Re-opening on every
            // poll churned a credential and a session list that had not moved.
            if changed || connectedBox != selectedBox {
                if changed {
                    trace(
                        "boxes: "
                            + fetched.map { "\($0.name)=\($0.status)" }.joined(separator: " "))
                }
                await openBox()
            }
        } catch {
            trace("boxes failed: \(error.localizedDescription)")
            self.error = error.localizedDescription
        }
    }

    /// Build the droplet back, then watch until it answers.
    /// Put the box down on purpose.
    ///
    /// Everything running on it ends, which is why the callers ask first. The
    /// files do not: they are on the workspace, which is the only reason this
    /// is offered at all.
    func sleep() async {
        guard let box, box.canSleep else { return }
        busyBox = box.id
        do {
            trace("sleeping \(box.name)")
            try await control.sleep(box: box.id)
        } catch {
            self.error = error.localizedDescription
            busyBox = nil
            return
        }
        // The machine is gone, so the terminals attached to it are too. Left in
        // place they are rows that open a socket to a hostname with nothing on
        // the other end.
        sessions = []
        selectedSession = nil
        await refreshBoxes()
    }

    func wake() async {
        guard let box, box.asleep else { return }
        busyBox = box.id
        logCursor = 0
        buildLog = []
        do {
            trace("waking \(box.name)")
            try await control.wake(box: box.id)
        } catch {
            self.error = error.localizedDescription
            busyBox = nil
            return
        }
        await refreshBoxes()
    }

    /// Make a box, and start watching it build.
    func create(_ spec: Control.NewBox) async throws -> Control.Box {
        let made = try await control.createBox(spec)
        buildLog = []
        logCursor = 0
        await refreshBoxes()
        return made
    }

    func select(box id: Int) {
        guard selectedBox != id else { return }
        selectedBox = id
        selectedSession = nil
        buildLog = []
        logCursor = 0
        Task { await openBox() }
    }

    func openBox() async {
        guard canned == nil else { return }
        // The companion lives on the box, so there is one to talk to exactly
        // when the box is awake.
        runs.point(at: box?.awake == true ? box?.id : nil, control: control)
        guard let box, box.awake else {
            connection = nil
            connectedBox = nil
            sessions = []
            selectedSession = nil
            return
        }
        do {
            let fresh = try await control.connection(box: box.id)
            connection = fresh
            connectedBox = box.id
            sessions = try await control.sessions(box: box.id)
            trace("box \(box.name): \(sessions.count) session(s) on \(fresh.url)")
            if selectedSession == nil || !sessions.contains(where: { $0.id == selectedSession }) {
                selectedSession = sessions.first?.id
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// What the box is printing while it builds itself.
    ///
    /// A wake takes about three minutes and a first build rather longer. A
    /// spinner for that long is indistinguishable from a box that has died,
    /// which is exactly why the control plane keeps this log.
    func pollBuildLog() async {
        guard let box, box.building else { return }
        guard let out = try? await control.events(box: box.id, after: logCursor) else { return }
        guard !out.events.isEmpty else { return }
        buildLog.append(contentsOf: out.events)
        logCursor = out.events.last?.id ?? logCursor
        // Bounded: a long build is thousands of lines and only the tail is ever
        // on screen.
        if buildLog.count > 400 { buildLog.removeFirst(buildLog.count - 400) }
    }

    // MARK: - polling

    /// A box being built changes state without the user doing anything, so the
    /// sidebar has to find out on its own or it looks stuck.
    func startPolling() {
        guard canned == nil else { return }
        runs.startPolling()
        guard poll == nil else { return }
        poll = Task { [weak self] in
            while !Task.isCancelled {
                // Fast while something is being built — the log is the
                // interface then, and eight seconds between lines reads as a
                // machine that has stopped. Slow otherwise, because a settled
                // box has nothing to say and this is somebody's battery.
                let building = await MainActor.run { self?.box?.building ?? false }
                try? await Task.sleep(for: .seconds(building ? 2 : 15))
                guard !Task.isCancelled, let self else { return }
                await refreshBoxes()
                await pollBuildLog()
            }
        }
    }

    func stopPolling() {
        runs.stopPolling()
        poll?.cancel()
        poll = nil
    }

    // MARK: - sessions

    func newTerminal(_ argv: [String], cols: Int, rows: Int) async {
        guard let box else { return }
        do {
            trace("new terminal on \(box.name): \(argv.isEmpty ? "shell" : argv.joined(separator: " "))")
            let created = try await control.createSession(
                box: box.id, argv: argv, cols: cols, rows: rows)
            sessions = try await control.sessions(box: box.id)
            selectedSession = created.id
        } catch {
            trace("new terminal failed: \(error.localizedDescription)")
            self.error = error.localizedDescription
        }
    }

    func closeTerminal(_ id: String) async {
        guard let box else { return }
        sessionStore.drop(id)
        try? await control.killSession(box: box.id, id: id)
        sessions = (try? await control.sessions(box: box.id)) ?? []
        if selectedSession == id { selectedSession = sessions.first?.id }
    }

    func selectSession(at index: Int) {
        guard index >= 0, index < sessions.count else { return }
        selectedSession = sessions[index].id
    }

    /// Cycle to the next or previous terminal, for the keyboard shortcuts.
    func cycleSession(by delta: Int) {
        guard !sessions.isEmpty,
            let current = sessions.firstIndex(where: { $0.id == selectedSession })
        else {
            selectedSession = sessions.first?.id
            return
        }
        let next = (current + delta + sessions.count) % sessions.count
        selectedSession = sessions[next].id
    }
}
