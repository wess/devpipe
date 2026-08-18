import SwiftUI

/// The app on a phone.
///
/// Four tabs, and their order is the argument. Work is first because runs are
/// what the product is: a task somebody asked for and the agents attempting it.
/// Inbox is second because the only thing more urgent than watching work is
/// being asked a question by it. The box — the machine, its build log, and its
/// terminals — is third, which is the demotion this whole rewrite is about: a
/// terminal is a pane you open on a box, not the face of the product.
///
/// Deliberately not the iPad's split view scaled down. A `NavigationSplitView`
/// in a compact size class collapses to a stack whose root is the sidebar, so a
/// phone would open on a column of boxes and terminals — a navigation aid
/// standing in for a screen. Tabs put the work first and keep the machine one
/// press away.
struct PhoneShell: View {
    @ObservedObject var workspace: Workspace

    enum Tab: Hashable { case work, inbox, box, you }

    @State private var tab = Tab.work
    @State private var work: [Asylum.Task] = []
    @State private var opened: [String] = []
    @State private var makingBox = false
    @State private var pendingURL: URL?

    private var runs: RunsModel { workspace.runs }

    var body: some View {
        TabView(selection: $tab) {
            WorkTab(workspace: workspace, path: $work)
                .tabItem { Label("Work", systemImage: "square.stack.3d.up.fill") }
                .tag(Tab.work)

            InboxTab(runs: runs)
                .tabItem { Label("Inbox", systemImage: "bell.fill") }
                .badge(runs.unread)
                .tag(Tab.inbox)

            BoxTab(
                workspace: workspace, path: $opened, makingBox: $makingBox,
                onOpenURL: { pendingURL = $0 })
                .tabItem { Label("Box", systemImage: "shippingbox.fill") }
                .tag(Tab.box)

            YouTab(workspace: workspace)
                .tabItem { Label("You", systemImage: "person.crop.circle.fill") }
                .tag(Tab.you)
        }
        .sheet(isPresented: $makingBox) {
            NewBoxSheet(workspace: workspace) {
                Task { await workspace.openBox() }
            }
        }
        .sheet(item: $pendingURL) { url in
            SafariSheet(url: url).ignoresSafeArea()
        }
        .onAppear {
            // A notification about a terminal opens that terminal, which on a
            // phone means changing tab as well as pushing a screen. Without the
            // first half the push happens behind whatever the person was
            // looking at.
            NotificationPresenter.shared.onOpenSession = { id in
                workspace.selectedSession = id
                tab = .box
                opened = [id]
            }
        }
    }
}

// MARK: - work

/// A project's tasks, grouped by what they need.
///
/// The grouping is the whole design. A flat list sorted by whatever the box
/// returned buries the one task that is blocked on a question underneath nine
/// that are finished, and the blocked one is the only reason anybody opened the
/// app on a phone.
private struct WorkTab: View {
    @ObservedObject var workspace: Workspace
    @Binding var path: [Asylum.Task]

    @ObservedObject private var runs: RunsModel

    init(workspace: Workspace, path: Binding<[Asylum.Task]>) {
        self.workspace = workspace
        self._path = path
        self.runs = workspace.runs
    }

    private var needsYou: [Asylum.Task] { runs.tasks.filter { Asylum.Tone.of($0.status) == .warn } }
    private var working: [Asylum.Task] { runs.tasks.filter { Asylum.Tone.of($0.status) == .live } }
    private var rest: [Asylum.Task] {
        runs.tasks.filter {
            let tone = Asylum.Tone.of($0.status)
            return tone != .warn && tone != .live
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if runs.tasks.isEmpty {
                    RunsEmpty(runs: runs, hasBox: workspace.box?.awake == true)
                } else {
                    list
                }
            }
            .background(Design.theme.background.color.ignoresSafeArea())
            .navigationTitle(project?.name ?? "Work")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .navigationDestination(for: Asylum.Task.self) { task in
                TaskScreen(runs: runs, task: task)
            }
            .refreshable { await runs.refresh() }
        }
    }

    private var project: Asylum.Project? {
        runs.projects.first { $0.id == runs.project }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                group("Needs you", needsYou)
                group("Working", working)
                group(needsYou.isEmpty && working.isEmpty ? "Tasks" : "Everything else", rest)
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 20)
        }
    }

    @ViewBuilder private func group(_ title: String, _ items: [Asylum.Task]) -> some View {
        if !items.isEmpty {
            SectionHeader(title: title)
                .padding(.horizontal, -14)
            ForEach(items) { task in
                NavigationLink(value: task) {
                    TaskRow(task: task, pushes: true)
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        // Centred, and the only title the screen has. A project name in the
        // navigation bar *and* in a menu underneath it is the same word twice.
        ToolbarItem(placement: .principal) {
            // A menu rather than a column of its own. Nearly everybody has one
            // project in flight, and a phone has no width to spend on a list
            // that is usually one row long.
            Menu {
                ForEach(runs.projects) { project in
                    Button {
                        runs.select(project: project.id)
                    } label: {
                        Label(
                            project.name,
                            systemImage: project.id == runs.project
                                ? "checkmark" : project.pinned ? "pin" : "folder")
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(project?.name ?? "No project")
                        .font(Design.mono(15, .semibold))
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .bold))
                }
                .foregroundStyle(Design.theme.foreground.color)
            }
            .disabled(runs.projects.isEmpty)
        }
        ToolbarItem(placement: .topBarTrailing) {
            if let box = workspace.box {
                // Which box these runs are on, and a way to change it. It looks
                // like a control because it is one — the box decides everything
                // else on the screen.
                Menu {
                    ForEach(workspace.boxes) { other in
                        Button {
                            workspace.select(box: other.id)
                        } label: {
                            Label(
                                other.name,
                                systemImage: other.id == workspace.selectedBox
                                    ? "checkmark" : "shippingbox")
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        StatusDot(
                            kind: box.awake ? .live : box.asleep ? .asleep : .busy,
                            pulses: box.building)
                        Text(box.name)
                            .font(Design.mono(11))
                            .foregroundStyle(Design.theme.muted.color)
                    }
                }
            }
        }
    }
}

/// One task, and every attempt at it.
///
/// The runs are cards rather than rows because each one carries three
/// independent things — who, where, and what it is doing right now — and the
/// third is a sentence. A row that fits all three has room for none of them.
private struct TaskScreen: View {
    @ObservedObject var runs: RunsModel
    let task: Asylum.Task

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .top, spacing: 10) {
                        Text(task.title)
                            .font(Design.text(20, .semibold))
                            .foregroundStyle(Design.theme.foreground.color)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        StatusPill(status: task.status, large: true)
                    }
                    .padding(.bottom, 2)

                    if runs.runs.isEmpty {
                        VStack(spacing: 8) {
                            Text("No runs yet")
                                .font(Design.text(15, .medium))
                                .foregroundStyle(Design.theme.foreground.color)
                            Text("Nothing has been dispatched against this task.")
                                .font(Design.text(13))
                                .foregroundStyle(Design.theme.muted.color)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 40)
                    } else {
                        ForEach(runs.runs) { run in
                            RunCard(run: run)
                        }
                    }
                }
                .padding(16)
            }
            Composer(runs: runs)
        }
        .background(Design.theme.background.color.ignoresSafeArea())
        .navigationTitle("Runs")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        // The pushed screen is what decides which task's runs are being
        // followed, so the poller starts asking about this one on arrival.
        .task(id: task.id) { runs.select(task: task.id) }
    }
}

// MARK: - inbox

private struct InboxTab: View {
    @ObservedObject var runs: RunsModel

    var body: some View {
        NavigationStack {
            Group {
                if runs.inbox.isEmpty {
                    EmptyPane(
                        icon: "bell.slash",
                        title: "Nothing waiting",
                        detail: "When a run finishes, or stops to ask you something, it says so here."
                    ) {}
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(runs.inbox) { note in
                                NoteRow(note: note)
                                Divider().overlay(Design.theme.border.color).padding(.leading, 31)
                            }
                        }
                    }
                }
            }
            .background(Design.theme.background.color.ignoresSafeArea())
            .navigationTitle("Inbox")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await runs.refresh() }
        }
    }
}

// MARK: - box

/// The machine, and its terminals.
///
/// Everything the app used to open on lives here now: what the box is doing,
/// how to wake it, what it printed while building itself, and the shells and
/// agents running on it. Demoted, not removed — this is the screen you come to
/// when the runs screen has told you something needs a person.
private struct BoxTab: View {
    @ObservedObject var workspace: Workspace
    @Binding var path: [String]
    @Binding var makingBox: Bool
    let onOpenURL: (URL) -> Void

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if workspace.boxes.isEmpty {
                    EmptyPane(
                        icon: "server.rack",
                        title: "You do not have a box yet",
                        detail: "About three minutes from here to a shell with your agents on it."
                    ) {
                        Button("Make one") { makingBox = true }
                            .buttonStyle(FilledButtonStyle())
                    }
                } else {
                    content
                }
            }
            .background(Design.theme.background.color.ignoresSafeArea())
            .navigationTitle(workspace.box?.name ?? "Box")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .navigationDestination(for: String.self) { id in
                terminal(id)
            }
        }
    }

    @ViewBuilder private var content: some View {
        if let box = workspace.box, box.building {
            BuildingPane(workspace: workspace, box: box)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    machine
                    terminals
                }
                .padding(.bottom, 24)
            }
        }
    }

    @ViewBuilder private var machine: some View {
        if let box = workspace.box {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 9) {
                    StatusDot(kind: box.awake ? .live : box.asleep ? .asleep : .busy)
                    Text(box.awake ? box.hostname : box.status_detail.isEmpty ? box.status : box.status_detail)
                        .font(Design.mono(12))
                        .foregroundStyle(Design.theme.muted.color)
                        .lineLimit(1)
                        .truncationMode(.head)
                    Spacer(minLength: 0)
                    if box.awake {
                        Text(box.ip)
                            .font(Design.mono(10.5))
                            .foregroundStyle(Design.theme.faint.color)
                    }
                }

                // What this machine was built with, which is the question the
                // screen is usually being opened to answer — an agent missing
                // from the list below is missing because it is not on the box.
                if !box.tools.isEmpty {
                    FlowRow(spacing: 5) {
                        ForEach(box.tools, id: \.self) { tool in
                            Pill(text: tool, tint: Design.theme.faint.color)
                        }
                    }
                }

                if box.asleep {
                    Text("Its work is still on its workspace. Building the machine back takes about three minutes.")
                        .font(Design.text(13))
                        .foregroundStyle(Design.theme.muted.color)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(workspace.busyBox == box.id ? "Waking…" : "Wake it") {
                        Task { await workspace.wake() }
                    }
                    .buttonStyle(FilledButtonStyle(wide: true))
                    .disabled(workspace.busyBox == box.id)
                }
            }
            .padding(16)
            .background(Design.theme.surface.color)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Design.theme.border.color).frame(height: 0.5)
            }
        }
    }

    @ViewBuilder private var terminals: some View {
        if workspace.box?.awake == true {
            SectionHeader(title: "Terminals")

            if workspace.sessions.isEmpty {
                Text("Nothing running.")
                    .font(Design.text(13))
                    .foregroundStyle(Design.theme.faint.color)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 6)
            }

            ForEach(workspace.sessions) { session in
                NavigationLink(value: session.id) {
                    sessionRow(session)
                }
                .buttonStyle(.plain)
                .contextMenu {
                    Button("Close terminal", systemImage: "xmark", role: .destructive) {
                        Task { await workspace.closeTerminal(session.id) }
                    }
                }
            }

            SectionHeader(title: "Open")
            VStack(spacing: 6) {
                Button {
                    Task { await open([]) }
                } label: {
                    Label("shell", systemImage: "chevron.left.forwardslash.chevron.right")
                }
                .buttonStyle(QuietButtonStyle(wide: true))

                // From the catalogue, filtered by what this box actually has,
                // each started by the argv the catalogue gives it.
                ForEach(workspace.agents) { tool in
                    Button {
                        Task { await open(tool.launch ?? [tool.id]) }
                    } label: {
                        Label(tool.name, systemImage: "sparkles")
                    }
                    .buttonStyle(QuietButtonStyle(tint: Design.theme.accent.color, wide: true))
                }
            }
            .padding(.horizontal, 12)
        }
    }

    private func sessionRow(_ session: Control.RemoteSession) -> some View {
        let live = workspace.sessionStore.existing(session.id)
        return HStack(spacing: 10) {
            StatusDot(kind: session.alive ? .live : .gone)
            VStack(alignment: .leading, spacing: 2) {
                Text(live?.title ?? session.label)
                    .font(Design.mono(14))
                    .foregroundStyle(Design.theme.foreground.color)
                    .lineLimit(1)
                Text("\(session.id) · \(session.cols)×\(session.rows)")
                    .font(Design.mono(10.5))
                    .foregroundStyle(Design.theme.faint.color)
            }
            Spacer(minLength: 4)
            // An agent asking for permission is the reason to look at a pane
            // you are not looking at, so it says so from here.
            if live?.attention != nil {
                Image(systemName: "bell.badge.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(Design.theme.warning.color)
            }
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Design.theme.faint.color)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
    }

    @ViewBuilder private func terminal(_ id: String) -> some View {
        if let connection = workspace.connection {
            TerminalScreen(
                workspace: workspace,
                session: workspace.sessionStore.session(for: id, connection: connection),
                onOpenURL: onOpenURL
            )
            .id(id)
            .navigationBarTitleDisplayMode(.inline)
            // A terminal wants the whole screen. Leaving the tab bar up costs
            // it three rows on a device that has few to spare, and every one of
            // them is a row of somebody's build log.
            .toolbar(.hidden, for: .tabBar)
        } else {
            EmptyPane(icon: "bolt.slash", title: "Not connected", detail: nil) {}
        }
    }

    private func open(_ argv: [String]) async {
        await workspace.newTerminal(argv, cols: 80, rows: 24)
        if let id = workspace.selectedSession { path = [id] }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                ForEach(workspace.boxes) { box in
                    Button {
                        workspace.select(box: box.id)
                    } label: {
                        Label(
                            box.name,
                            systemImage: box.id == workspace.selectedBox
                                ? "checkmark" : "shippingbox")
                    }
                }
                Divider()
                Button("New box…", systemImage: "plus") { makingBox = true }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
    }
}

// MARK: - you

private struct YouTab: View {
    @ObservedObject var workspace: Workspace
    @State private var showingAccount = false
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    identity
                    row("Account", "person.crop.circle") { showingAccount = true }
                    row("Settings", "gearshape") { showingSettings = true }
                    row("Sign out", "rectangle.portrait.and.arrow.right", destructive: true) {
                        Task { await workspace.signOut() }
                    }

                    if let error = workspace.error {
                        Text(error)
                            .font(Design.mono(11))
                            .foregroundStyle(Design.theme.warning.color)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(16)
                    }
                }
            }
            .background(Design.theme.background.color.ignoresSafeArea())
            .navigationTitle("You")
            .navigationBarTitleDisplayMode(.inline)
        }
        .sheet(isPresented: $showingAccount) { AccountSheet(workspace: workspace) }
        .sheet(isPresented: $showingSettings) { SettingsSheet() }
    }

    private var identity: some View {
        VStack(spacing: 5) {
            Image(systemName: "person.crop.circle.fill")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(Design.theme.accent.color)
            Text(workspace.user?.name ?? workspace.user?.username ?? "")
                .font(Design.text(18, .semibold))
                .foregroundStyle(Design.theme.foreground.color)
            Text(workspace.user?.email ?? "")
                .font(Design.mono(12))
                .foregroundStyle(Design.theme.faint.color)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 26)
    }

    private func row(
        _ title: String, _ icon: String, destructive: Bool = false, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 15))
                    .frame(width: 22)
                Text(title).font(Design.text(16))
                Spacer()
                if !destructive {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Design.theme.faint.color)
                }
            }
            .foregroundStyle(
                destructive ? Design.theme.warning.color : Design.theme.foreground.color
            )
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Design.theme.border.color).frame(height: 0.5).padding(.leading, 50)
        }
    }
}
