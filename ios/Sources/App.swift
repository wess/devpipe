import OSLog
import SafariServices
import SwiftUI
import UIKit

/// Readable from the host with:
///   xcrun simctl spawn <udid> log show --info --last 1m \
///     --predicate 'subsystem == "io.wess.devpipe"'
let log = Logger(subsystem: "io.wess.devpipe", category: "spike")

/// Where terminal bytes come from. Fixtures for the render spike, a websocket
/// for a real session; the renderer cannot tell them apart.
protocol ByteSource: AnyObject {
    var onBytes: ((Data) -> Void)? { get set }
    func start()
    func stop()
    func send(_ data: Data)
    func resize(cols: Int, rows: Int)
}

struct Stats {
    var cols = 0
    var rows = 0
    var fps: Double = 0
    var rebuildMs: Double = 0
    var drawMs: Double = 0
    var feedMBps: Double = 0
}

/// Owns the emulator, the frame loop, and whatever source is feeding it.
final class TerminalController: ObservableObject {
    @Published var stats = Stats()
    @Published var status = "idle"
    /// A link the user tapped, waiting to be presented.
    @Published var pendingURL: URL?

    let term = Term(cols: 80, rows: 24)
    weak var view: TerminalUIView?
    private var source: ByteSource?
    private var displayLink: CADisplayLink?

    private var frameCount = 0
    private var lastFPSStamp = CFAbsoluteTimeGetCurrent()
    private var feedSeconds: Double = 0
    private var feedBytes = 0

    func attach(_ view: TerminalUIView) {
        self.view = view
        view.term = term
        view.onFrameCost = { [weak self] rebuild, total in
            guard let self else { return }
            // Smoothed: raw per-frame numbers are unreadable at 60Hz.
            stats.rebuildMs = stats.rebuildMs * 0.9 + rebuild * 0.1
            stats.drawMs = stats.drawMs * 0.9 + total * 0.1
        }
        view.onInput = { [weak self] data in self?.source?.send(data) }
        view.onOpenURL = { [weak self] url in
            DispatchQueue.main.async { self?.pendingURL = url }
        }
        if displayLink == nil {
            let link = CADisplayLink(target: self, selector: #selector(frame))
            link.add(to: .main, forMode: .common)
            displayLink = link
        }
    }

    @objc private func frame() {
        view?.refresh()
        frameCount += 1
        let now = CFAbsoluteTimeGetCurrent()
        let elapsed = now - lastFPSStamp
        guard elapsed >= 0.5 else { return }
        stats.fps = Double(frameCount) / elapsed
        stats.feedMBps = feedSeconds > 0 ? (Double(feedBytes) / 1_048_576.0) / feedSeconds : 0
        frameCount = 0
        feedSeconds = 0
        feedBytes = 0
        lastFPSStamp = now
        log.info("""
            grid=\(self.stats.cols)x\(self.stats.rows) \
            fps=\(self.stats.fps, format: .fixed(precision: 1)) \
            build=\(self.stats.rebuildMs, format: .fixed(precision: 2))ms \
            draw=\(self.stats.drawMs, format: .fixed(precision: 2))ms \
            feed=\(self.stats.feedMBps, format: .fixed(precision: 1))MB/s
            """)
    }

    /// Match the pty to what the view can actually show. A mismatch is what
    /// produces wrapped prompts and TUIs drawing off the edge.
    func syncGrid() {
        guard let view else { return }
        let (cols, rows) = view.gridSize()
        guard cols != term.cols || rows != term.rows else { return }
        term.resize(cols: cols, rows: rows)
        source?.resize(cols: cols, rows: rows)
        stats.cols = cols
        stats.rows = rows
        view.invalidateAll()
    }

    func run(_ newSource: ByteSource) {
        source?.stop()
        term.reset()
        view?.invalidateAll()
        source = newSource
        newSource.onBytes = { [weak self] data in
            guard let self else { return }
            let t0 = CFAbsoluteTimeGetCurrent()
            term.feed(data)
            feedSeconds += CFAbsoluteTimeGetCurrent() - t0
            feedBytes += data.count
            // Whatever the emulator owes the pty goes straight back out;
            // a program that asked a question is waiting on it.
            if let reply = term.takeOutput() { newSource.send(reply) }
        }
        if let ws = newSource as? WebSocketSource {
            ws.onState = { [weak self] s in
                DispatchQueue.main.async { self?.status = s }
                log.info("source: \(s)")
            }
        }
        newSource.start()
        newSource.resize(cols: term.cols, rows: term.rows)
    }

    func stop() {
        source?.stop()
        source = nil
    }
}

/// Wraps `SFSafariViewController`, which keeps the browser inside the app while
/// still running in Safari's own session — so an existing claude.com login is
/// already there and the user is not asked to sign in twice.
struct SafariSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let vc = SFSafariViewController(url: url)
        vc.preferredControlTintColor = UIColor(cgColor: Palette.cursor)
        vc.preferredBarTintColor = UIColor(cgColor: Palette.background)
        return vc
    }

    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}

struct TerminalHost: UIViewRepresentable {
    let controller: TerminalController

    func makeUIView(context: Context) -> TerminalUIView {
        let v = TerminalUIView(fontSize: 13)
        controller.attach(v)
        DispatchQueue.main.async { v.becomeFirstResponder() }
        return v
    }

    func updateUIView(_ view: TerminalUIView, context: Context) {
        DispatchQueue.main.async { controller.syncGrid() }
    }
}

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

    private var logCursor = 0

    let control = Control.fromLaunchArgs()
    private var poll: Task<Void, Never>?

    var box: Control.Box? { boxes.first { $0.id == selectedBox } }

    /// The agents actually on this box, each with the argv it is started by.
    ///
    /// Catalogue order, filtered by what the box was built with — the same
    /// rule the web client follows, from the same endpoint, so the two cannot
    /// drift on what a tool is called or how it starts.
    var agents: [Control.Tool] {
        guard let box else { return [] }
        return catalog.filter { $0.group == "agent" && $0.launch != nil && box.tools.contains($0.id) }
    }

    func restore() async {
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

    /// Make a box, and start watching it build.
    func create(_ spec: Control.NewBox) async throws -> Control.Box {
        let made = try await control.createBox(spec)
        buildLog = []
        logCursor = 0
        await refreshBoxes()
        return made
    }

    /// Build the droplet back, then watch until it answers.
    func wake() async {
        guard let box, box.asleep else { return }
        busyBox = box.id
        logCursor = 0
        buildLog = []
        do {
            try await control.wake(box: box.id)
        } catch {
            self.error = error.localizedDescription
            busyBox = nil
            return
        }
        await refreshBoxes()
    }

    /// What the box is printing while it builds itself.
    ///
    /// A wake takes about three minutes and a first build rather longer. A
    /// spinner for that long is indistinguishable from a box that has died,
    /// which is exactly why the control plane keeps this log — the web client
    /// has shown it from the start and the iPad showed one static line.
    func pollBuildLog() async {
        guard let box, box.building else { return }
        guard let out = try? await control.events(box: box.id, after: logCursor) else { return }
        if !out.events.isEmpty {
            buildLog.append(contentsOf: out.events)
            logCursor = out.events.last?.id ?? logCursor
            // Bounded: a long build is thousands of lines and only the tail is
            // ever on screen.
            if buildLog.count > 300 { buildLog.removeFirst(buildLog.count - 300) }
        }
    }

    func refreshBoxes() async {
        do {
            boxes = try await control.boxes()
            if selectedBox == nil {
                selectedBox = boxes.first(where: { $0.awake })?.id ?? boxes.first?.id
            }
            // The wake finished, so the button stops saying it is working.
            if let busy = busyBox, boxes.first(where: { $0.id == busy })?.awake == true {
                busyBox = nil
            }
            await openBox()
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// A box being built changes state without the user doing anything, so the
    /// sidebar has to find out on its own or it looks stuck.
    func startPolling() {
        poll?.cancel()
        poll = Task { [weak self] in
            while !Task.isCancelled {
                // Faster while something is being built: the log is the
                // interface then, and eight seconds between lines reads as a
                // machine that has stopped.
                let building = await MainActor.run { self?.box?.building ?? false }
                try? await Task.sleep(nanoseconds: building ? 2_000_000_000 : 8_000_000_000)
                guard let self else { return }
                await self.refreshBoxes()
                await self.pollBuildLog()
            }
        }
    }

    func openBox() async {
        guard let box, box.awake else {
            connection = nil
            sessions = []
            selectedSession = nil
            return
        }
        do {
            connection = try await control.connection(box: box.id)
            sessions = try await control.sessions(box: box.id)
            if selectedSession == nil || !sessions.contains(where: { $0.id == selectedSession }) {
                selectedSession = sessions.first?.id
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func newTerminal(_ argv: [String], cols: Int, rows: Int) async {
        guard let box else { return }
        do {
            let created = try await control.createSession(
                box: box.id, argv: argv, cols: cols, rows: rows)
            sessions = try await control.sessions(box: box.id)
            selectedSession = created.id
        } catch {
            self.error = error.localizedDescription
        }
    }

    func closeTerminal(_ id: String) async {
        guard let box else { return }
        try? await control.killSession(box: box.id, id: id)
        sessions = (try? await control.sessions(box: box.id)) ?? []
        if selectedSession == id { selectedSession = sessions.first?.id }
    }

    func signOut() async {
        await control.signOut()
        user = nil
        boxes = []
        sessions = []
        connection = nil
    }
}

/// Sign in. Deliberately the same copy as the web client's gate.
struct Gate: View {
    @ObservedObject var workspace: Workspace
    @State private var needsOwner = false
    @State private var inviteRequired = false
    @State private var invite = ""
    @State private var registering = false
    @State private var email = ""
    @State private var username = ""
    @State private var name = ""
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: "terminal")
                Text("Devpipe").font(.system(size: 17, weight: .semibold))
            }
            .foregroundColor(.white)

            if needsOwner {
                Text("This instance has no owner yet. The first account created becomes the owner.")
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(Color(cgColor: Palette.cursor))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error {
                Text(error)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            TextField("Email", text: $email)
                .textContentType(.username)
                .keyboardType(.emailAddress)
                .autocapitalization(.none)
            if registering || needsOwner {
                TextField("Username", text: $username).autocapitalization(.none)
                TextField("Name", text: $name)
                // Only when the instance says so, and asked for up front
                // rather than after a whole form has been filled in and
                // refused. Without this the button could only ever fail.
                if inviteRequired && !needsOwner {
                    TextField("Invite code", text: $invite).autocapitalization(.none)
                }
            }
            SecureField("Password", text: $password).textContentType(.password)

            Button(busy ? "…" : (registering || needsOwner) ? "Create account" : "Sign in") {
                Task { await submit() }
            }
            .disabled(busy)

            if !needsOwner {
                Button(registering ? "I already have an account" : "Create an account") {
                    registering.toggle()
                    error = nil
                }
                .font(.system(size: 12))
            }
        }
        .textFieldStyle(.roundedBorder)
        .frame(maxWidth: 340)
        .padding(24)
        .task {
            if let state = try? await workspace.control.authState() {
                needsOwner = state.needs_owner
                inviteRequired = state.invite_required
            }
        }
    }

    private func submit() async {
        busy = true
        error = nil
        do {
            let user =
                (registering || needsOwner)
                ? try await workspace.control.register(
                    email: email, username: username, name: name, password: password,
                    invite: invite)
                : try await workspace.control.signIn(email: email, password: password)
            workspace.user = user
            await workspace.loadCatalog()
            await workspace.refreshBoxes()
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }
}

struct ContentView: View {
    @StateObject private var controller = TerminalController()
    @StateObject private var workspace = Workspace()
    @State private var making = false

    var body: some View {
        Group {
            if workspace.loading {
                ProgressView().tint(.white)
            } else if workspace.user == nil {
                Gate(workspace: workspace)
            } else {
                terminalWorkspace
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(cgColor: Palette.background))
        .preferredColorScheme(.dark)
        .task {
            await workspace.restore()
            workspace.startPolling()
        }
        .sheet(isPresented: $making) {
            NewBoxSheet(workspace: workspace) {
                Task { await workspace.openBox() }
            }
        }
    }

    /// The left column is boxes and their terminals; the right is the terminal.
    /// The web client renders the same two panes in the same order.
    private var terminalWorkspace: some View {
        HStack(spacing: 0) {
            sidebar
                .frame(width: 210)
                .background(Color(cgColor: Palette.background).brightness(-0.02))
            Divider().overlay(Color.white.opacity(0.1))
            VStack(spacing: 0) {
                hud
                if workspace.connection != nil, workspace.selectedSession != nil {
                    TerminalHost(controller: controller)
                } else {
                    empty
                }
            }
        }
    }

    /// What fills the pane when there is no terminal to show.
    ///
    /// Four different situations used to collapse into one line of grey text,
    /// and the one that mattered most — a box asleep, which is where every box
    /// ends up — offered nothing to do about it.
    @ViewBuilder private var empty: some View {
        if let box = workspace.box, box.building {
            buildingPane(box)
        } else {
            VStack(spacing: 12) {
                Image(systemName: workspace.boxes.isEmpty ? "server.rack" : "moon.zzz")
                    .font(.system(size: 26))
                if workspace.boxes.isEmpty {
                    Text("You do not have a box yet.")
                        .font(.system(size: 13, design: .monospaced))
                    Button("Make one") { making = true }
                    Text("About three minutes from here to a shell.")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(.gray.opacity(0.7))
                } else if let box = workspace.box, box.asleep {
                    Text("\(box.name) is asleep. Its work is still on its workspace.")
                        .font(.system(size: 13, design: .monospaced))
                    Button(workspace.busyBox == box.id ? "Waking…" : "Wake it") {
                        Task { await workspace.wake() }
                    }
                    .disabled(workspace.busyBox == box.id)
                    Text("Building the machine back takes about three minutes.")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(.gray.opacity(0.7))
                } else {
                    Text("Open a terminal to get started.")
                        .font(.system(size: 13, design: .monospaced))
                }
            }
            .foregroundColor(.gray)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// The build log, because a spinner for three minutes is indistinguishable
    /// from a box that has died. The control plane has streamed this from the
    /// start; only this client was not reading it.
    private func buildingPane(_ box: Control.Box) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small).tint(.gray)
                Text(box.status_detail.isEmpty ? box.status : box.status_detail)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundColor(Color(cgColor: Palette.cursor))
            }
            ScrollViewReader { scroller in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(workspace.buildLog) { line in
                            Text(line.line)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundColor(colorFor(line.line))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(line.id)
                        }
                    }
                }
                .onChange(of: workspace.buildLog.count) { _, _ in
                    // Follow the tail: the interesting line is always the last.
                    if let last = workspace.buildLog.last?.id {
                        withAnimation { scroller.scrollTo(last, anchor: .bottom) }
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func colorFor(_ line: String) -> Color {
        if line.hasPrefix("[!!]") { return .orange }
        if line.hasPrefix("[ok]") { return .green }
        if line.hasPrefix("==") { return Color(cgColor: Palette.cursor) }
        return .gray
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                sectionHead("BOXES")
                Spacer()
                Button {
                    making = true
                } label: {
                    Image(systemName: "plus").font(.system(size: 11, weight: .semibold))
                }
                .buttonStyle(.plain)
                .foregroundColor(.gray)
                .padding(.trailing, 12)
                .padding(.top, 14)
            }
            ForEach(workspace.boxes) { box in
                Button {
                    workspace.selectedBox = box.id
                    workspace.selectedSession = nil
                    Task { await workspace.openBox() }
                } label: {
                    row(
                        dot: box.awake ? Color.green : box.asleep ? Color.gray : Color.orange,
                        title: box.name,
                        subtitle: box.awake ? box.hostname : box.status,
                        selected: workspace.selectedBox == box.id)
                }
                .buttonStyle(.plain)
            }

            sectionHead("TERMINALS")
            ScrollView {
                ForEach(workspace.sessions) { session in
                    HStack(spacing: 0) {
                        Button {
                            workspace.selectedSession = session.id
                        } label: {
                            row(
                                dot: session.alive ? Color.green : Color.gray,
                                title: session.label,
                                subtitle: "\(session.id) · \(session.cols)x\(session.rows)",
                                selected: workspace.selectedSession == session.id)
                        }
                        .buttonStyle(.plain)
                        Button {
                            Task { await workspace.closeTerminal(session.id) }
                        } label: {
                            Image(systemName: "xmark").font(.system(size: 10))
                        }
                        .buttonStyle(.plain)
                        .foregroundColor(.gray)
                        .padding(.trailing, 10)
                    }
                }
            }

            Spacer()

            VStack(alignment: .leading, spacing: 4) {
                if workspace.box?.awake == true {
                    Button("+ shell") {
                        Task {
                            await workspace.newTerminal(
                                [], cols: controller.term.cols, rows: controller.term.rows)
                        }
                    }
                    // From the catalogue, filtered by what this box actually
                    // has. The old pair of hardcoded buttons offered claude on
                    // a box built with codex, and started it bare — without
                    // the flag that lets an agent act without stopping to ask,
                    // which the web client has always sent.
                    ForEach(workspace.agents) { tool in
                        Button("+ \(tool.launch?.first ?? tool.id)") {
                            Task {
                                await workspace.newTerminal(
                                    tool.launch ?? [tool.id],
                                    cols: controller.term.cols, rows: controller.term.rows)
                            }
                        }
                    }
                } else if workspace.box?.asleep == true {
                    Button(workspace.busyBox == workspace.box?.id ? "waking…" : "wake") {
                        Task { await workspace.wake() }
                    }
                    .disabled(workspace.busyBox == workspace.box?.id)
                }
                Button("sign out") { Task { await workspace.signOut() } }
                    .foregroundColor(.gray)
            }
            .font(.system(size: 12, design: .monospaced))
            .padding(12)
            if let error = workspace.error {
                Text(error)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(.orange)
                    .lineLimit(3)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
            }
        }
        .onChange(of: workspace.selectedSession) { _, _ in attach() }
        .onChange(of: workspace.connection?.token) { _, _ in attach() }
    }

    private func attach() {
        guard let conn = workspace.connection, let sid = workspace.selectedSession else { return }
        controller.run(
            WebSocketSource(
                config: DaemonConfig(
                    host: conn.url.replacingOccurrences(of: "wss://", with: ""),
                    port: 443,
                    token: conn.token,
                    fingerprint: "",
                    insecure: false),
                sessionId: sid))
    }

    private func sectionHead(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .foregroundColor(.gray)
            .padding(.horizontal, 12)
            .padding(.top, 14)
            .padding(.bottom, 6)
    }

    private func row(dot: Color, title: String, subtitle: String, selected: Bool) -> some View {
        HStack(spacing: 8) {
            Circle().fill(dot).frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(.white)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(.gray)
                    .lineLimit(1)
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(selected ? Color.white.opacity(0.08) : Color.clear)
        .contentShape(Rectangle())
    }

    private var hud: some View {
        let s = controller.stats
        return HStack(spacing: 14) {
            Text(workspace.box.map { "\($0.name) · \($0.hostname)" } ?? "No box")
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(.gray)
            Spacer()
            Text("\(s.cols)x\(s.rows)")
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(.gray)
            Text(controller.status)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(.gray)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.black.opacity(0.35))
    }
}

@main
struct DevpipeApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
                .statusBar(hidden: true)
        }
    }
}
