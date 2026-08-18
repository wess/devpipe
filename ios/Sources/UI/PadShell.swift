import SwiftUI

/// The app on an iPad.
///
/// Three columns, and the rule between them is the same one all the way down:
/// the sidebar picks a section, the middle column lists what is in it, and the
/// detail shows the one thing selected. Projects list tasks which show runs;
/// terminals list sessions which show a screen. Nothing in the middle column
/// ever means something different depending on where you came from.
///
/// This used to be two columns — boxes and their terminals on the left, one
/// terminal on the right — which was the whole product when the product was a
/// terminal. The terminals are still here. They are a section now, rather than
/// the reason the window exists.
struct PadShell: View {
    @ObservedObject var workspace: Workspace

    enum Focus: Hashable { case project(Int), inbox, terminals }

    @State private var columns = NavigationSplitViewVisibility.all
    @State private var focus: Focus?
    @State private var makingBox = false
    @State private var showingAccount = false
    @State private var showingSettings = false
    @State private var pendingURL: URL?

    private var runs: RunsModel { workspace.runs }

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            PadSidebar(
                workspace: workspace, focus: $focus, makingBox: $makingBox,
                showingAccount: $showingAccount, showingSettings: $showingSettings)
                .navigationSplitViewColumnWidth(min: 230, ideal: 260, max: 320)
        } content: {
            middle
                .navigationSplitViewColumnWidth(min: 280, ideal: 340, max: 440)
                .background(Design.theme.background.color.ignoresSafeArea())
                .toolbar(.hidden, for: .navigationBar)
        } detail: {
            // The theme's own ground, not the system's. A split view's detail
            // column defaults to pure black in dark mode, which next to the
            // sidebar's tinted slate reads as a hole in the app rather than as
            // a considered pair of surfaces.
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Design.theme.background.color.ignoresSafeArea())
                .toolbar(.hidden, for: .navigationBar)
        }
        .navigationSplitViewStyle(.balanced)
        .sheet(isPresented: $makingBox) {
            NewBoxSheet(workspace: workspace) {
                Task { await workspace.openBox() }
            }
        }
        .sheet(isPresented: $showingAccount) { AccountSheet(workspace: workspace) }
        .sheet(isPresented: $showingSettings) { SettingsSheet() }
        // In the app, in Safari's own session, so an existing claude.com login
        // is already there and the user is not asked to sign in twice.
        .sheet(item: $pendingURL) { url in
            SafariSheet(url: url).ignoresSafeArea()
        }
        .onAppear {
            NotificationPresenter.shared.onOpenSession = { id in
                workspace.selectedSession = id
                focus = .terminals
            }
        }
        // Opens on the work, not on the machine. Whichever project the box
        // considers current is the one somebody is most likely to be here for.
        //
        // Both halves are needed. The projects usually arrive after this view
        // does, which is what `onChange` is for; but a restored session can
        // have them already, and then nothing ever changes and the middle
        // column stays empty for as long as the window is open.
        .task { adopt(runs.project) }
        .onChange(of: runs.project) { _, project in adopt(project) }
    }

    private func adopt(_ project: Int?) {
        guard focus == nil, let project else { return }
        focus = .project(project)
    }

    // MARK: - middle

    @ViewBuilder private var middle: some View {
        switch focus {
        case .project:
            TaskList(runs: runs, hasBox: workspace.box?.awake == true)
        case .inbox:
            InboxList(runs: runs)
        case .terminals:
            SessionList(workspace: workspace)
        case nil:
            Color.clear
        }
    }

    // MARK: - detail

    @ViewBuilder private var detail: some View {
        if let box = workspace.box, box.building {
            BuildingPane(workspace: workspace, box: box)
        } else {
            switch focus {
            case .terminals: terminalDetail
            case .inbox: inboxDetail
            default: runsDetail
            }
        }
    }

    @ViewBuilder private var runsDetail: some View {
        if let task = runs.current {
            TaskDetail(runs: runs, task: task)
        } else {
            RunsEmpty(runs: runs, hasBox: workspace.box?.awake == true)
        }
    }

    @ViewBuilder private var inboxDetail: some View {
        EmptyPane(
            icon: "bell",
            title: "The inbox",
            detail: "Everything a run wanted to tell you. Pick a project to go back to the work itself."
        ) {}
    }

    @ViewBuilder private var terminalDetail: some View {
        if let connection = workspace.connection, let id = workspace.selectedSession {
            TerminalScreen(
                workspace: workspace,
                session: workspace.sessionStore.session(for: id, connection: connection),
                onOpenURL: { pendingURL = $0 })
            // Identity by session id: without it SwiftUI reuses the same
            // controller for a different terminal and the previous session's
            // screen is what you see.
            .id(id)
        } else if workspace.boxes.isEmpty {
            EmptyPane(
                icon: "server.rack",
                title: "You do not have a box yet",
                detail: "About three minutes from here to a shell with your agents on it."
            ) {
                Button("Make one") { makingBox = true }
                    .buttonStyle(FilledButtonStyle())
            }
        } else if let box = workspace.box, box.asleep {
            EmptyPane(
                icon: "moon.zzz",
                title: "\(box.name) is asleep",
                detail:
                    "Its work is still on its workspace. Building the machine back takes about three minutes."
            ) {
                Button(workspace.busyBox == box.id ? "Waking…" : "Wake it") {
                    Task { await workspace.wake() }
                }
                .buttonStyle(FilledButtonStyle())
                .disabled(workspace.busyBox == box.id)
            }
        } else {
            EmptyPane(
                icon: "terminal",
                title: "No terminal open",
                detail: "Open a shell or start an agent from the sidebar."
            ) {
                Button("Open a shell") {
                    Task { await workspace.newTerminal([], cols: 80, rows: 24) }
                }
                .buttonStyle(FilledButtonStyle())
            }
        }
    }
}

// MARK: - sidebar

/// Where everything is, and nothing is listed twice.
///
/// The box picker stays at the top because it is the one control that changes
/// what all three columns mean. Below it the sections are in the order they are
/// wanted: the projects being worked on, the things asking for a person, and
/// then the machine itself.
private struct PadSidebar: View {
    @ObservedObject var workspace: Workspace
    @Binding var focus: PadShell.Focus?
    @Binding var makingBox: Bool
    @Binding var showingAccount: Bool
    @Binding var showingSettings: Bool

    @ObservedObject private var runs: RunsModel

    init(
        workspace: Workspace, focus: Binding<PadShell.Focus?>, makingBox: Binding<Bool>,
        showingAccount: Binding<Bool>, showingSettings: Binding<Bool>
    ) {
        self.workspace = workspace
        self._focus = focus
        self._makingBox = makingBox
        self._showingAccount = showingAccount
        self._showingSettings = showingSettings
        self.runs = workspace.runs
    }

    var body: some View {
        VStack(spacing: 0) {
            boxPicker
            Divider().overlay(Design.theme.border.color)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    SectionHeader(title: "Projects")
                    if runs.projects.isEmpty {
                        placeholder(projectPlaceholder)
                    }
                    ForEach(runs.projects) { project in
                        row(
                            title: project.name,
                            icon: project.pinned ? "pin.fill" : "folder",
                            mono: true,
                            selected: focus == .project(project.id)
                        ) {
                            runs.select(project: project.id)
                            focus = .project(project.id)
                        }
                    }

                    SectionHeader(title: "Waiting")
                    row(
                        title: "Inbox", icon: "bell", mono: false, selected: focus == .inbox,
                        badge: runs.unread
                    ) {
                        focus = .inbox
                    }

                    SectionHeader(title: "Machine")
                    row(
                        title: "Terminals", icon: "terminal", mono: false,
                        selected: focus == .terminals,
                        badge: workspace.sessions.count
                    ) {
                        focus = .terminals
                    }
                }
                .padding(.horizontal, 6)
                .padding(.bottom, 10)
            }
            Divider().overlay(Design.theme.border.color)
            footer
        }
        .background(Design.theme.surface.color)
        .toolbar(.hidden, for: .navigationBar)
    }

    private var projectPlaceholder: String {
        guard let box = workspace.box else { return "No box yet." }
        if box.asleep { return "Wake the box to see its work." }
        if box.building { return "The box is still building." }
        if runs.reachable == false { return "The box is not answering." }
        return "No projects on this box yet."
    }

    private func placeholder(_ text: String) -> some View {
        Text(text)
            .font(Design.text(12))
            .foregroundStyle(Design.theme.faint.color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 8)
            .padding(.bottom, 6)
    }

    private func row(
        title: String, icon: String, mono: Bool, selected: Bool, badge: Int = 0,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Image(systemName: icon)
                    .font(.system(size: 12))
                    .frame(width: 16)
                    .foregroundStyle(
                        selected ? Design.theme.accent.color : Design.theme.faint.color)
                Text(title)
                    .font(mono ? Design.mono(13) : Design.text(14))
                    .foregroundStyle(Design.theme.foreground.color)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if badge > 0 {
                    Text("\(badge)")
                        .font(Design.mono(10, .semibold))
                        .foregroundStyle(Design.theme.background.color)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Design.theme.accent.color))
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(selected ? Design.theme.accent.color.opacity(0.16) : .clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// A menu rather than a list. Nearly everybody has one box and a list of
    /// one is a row of wasted height; the people with four want to switch, not
    /// to browse.
    private var boxPicker: some View {
        Menu {
            ForEach(workspace.boxes) { box in
                Button {
                    workspace.select(box: box.id)
                } label: {
                    Label(
                        box.name,
                        systemImage: box.id == workspace.selectedBox ? "checkmark" : "shippingbox")
                }
            }
            Divider()
            Button("New box…", systemImage: "plus") { makingBox = true }
        } label: {
            HStack(spacing: 10) {
                if let box = workspace.box {
                    StatusDot(kind: box.awake ? .live : box.asleep ? .asleep : .busy,
                              pulses: box.building)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(box.name)
                            .font(Design.mono(14, .medium))
                            .foregroundStyle(Design.theme.foreground.color)
                            .lineLimit(1)
                        Text(box.awake ? box.hostname : status(of: box))
                            .font(Design.mono(10.5))
                            .foregroundStyle(Design.theme.faint.color)
                            .lineLimit(1)
                    }
                } else {
                    Image(systemName: "shippingbox")
                        .foregroundStyle(Design.theme.faint.color)
                    Text("No box")
                        .font(Design.mono(14, .medium))
                        .foregroundStyle(Design.theme.muted.color)
                }
                Spacer(minLength: 6)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Design.theme.faint.color)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
    }

    private func status(of box: Control.Box) -> String {
        box.status_detail.isEmpty ? box.status : box.status_detail
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Button {
                    showingAccount = true
                } label: {
                    Label(workspace.user?.username ?? "account", systemImage: "person.crop.circle")
                        .lineLimit(1)
                }
                .buttonStyle(QuietButtonStyle(tint: Design.theme.muted.color, wide: true))
                Button {
                    showingSettings = true
                } label: {
                    Image(systemName: "gearshape")
                }
                .buttonStyle(QuietButtonStyle(tint: Design.theme.muted.color))
            }

            if let error = workspace.error {
                Text(error)
                    .font(Design.mono(10.5))
                    .foregroundStyle(Design.theme.warning.color)
                    .lineLimit(3)
                    .padding(.top, 2)
            }
        }
        .padding(12)
    }
}

// MARK: - middle columns

private struct TaskList: View {
    @ObservedObject var runs: RunsModel
    let hasBox: Bool

    var body: some View {
        VStack(spacing: 0) {
            SectionHeader(title: "Tasks")
            if runs.tasks.isEmpty {
                RunsEmpty(runs: runs, hasBox: hasBox)
            } else {
                ScrollView {
                    LazyVStack(spacing: 6) {
                        ForEach(runs.tasks) { task in
                            Button {
                                runs.select(task: task.id)
                            } label: {
                                TaskRow(task: task, selected: runs.task == task.id, pushes: false)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.bottom, 16)
                }
            }
        }
    }
}

private struct InboxList: View {
    @ObservedObject var runs: RunsModel

    var body: some View {
        VStack(spacing: 0) {
            SectionHeader(title: "Inbox")
            if runs.inbox.isEmpty {
                EmptyPane(
                    icon: "bell.slash", title: "Nothing waiting",
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
    }
}

private struct SessionList: View {
    @ObservedObject var workspace: Workspace

    var body: some View {
        VStack(spacing: 0) {
            SectionHeader(title: "Terminals")
            if workspace.sessions.isEmpty {
                Text(placeholder)
                    .font(Design.text(12))
                    .foregroundStyle(Design.theme.faint.color)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 8)
            }
            ScrollView {
                LazyVStack(spacing: 1) {
                    ForEach(Array(workspace.sessions.enumerated()), id: \.element.id) {
                        index, session in
                        sessionRow(session, index: index)
                    }
                }
                .padding(.horizontal, 6)
            }
            Divider().overlay(Design.theme.border.color)
            opener
        }
    }

    private var placeholder: String {
        guard let box = workspace.box else { return "No box yet." }
        if box.awake { return "Nothing running." }
        if box.asleep { return "Wake the box to open one." }
        return "The box is still building."
    }

    private func sessionRow(_ session: Control.RemoteSession, index: Int) -> some View {
        let live = workspace.sessionStore.existing(session.id)
        let selected = workspace.selectedSession == session.id
        return Button {
            workspace.selectedSession = session.id
        } label: {
            HStack(spacing: 9) {
                StatusDot(kind: session.alive ? .live : .gone)
                VStack(alignment: .leading, spacing: 2) {
                    Text(live?.title ?? session.label)
                        .font(Design.mono(12.5))
                        .foregroundStyle(Design.theme.foreground.color)
                        .lineLimit(1)
                    Text("\(session.id) · \(session.cols)×\(session.rows)")
                        .font(Design.mono(10))
                        .foregroundStyle(Design.theme.faint.color)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                if live?.attention != nil {
                    Image(systemName: "bell.badge.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(Design.theme.warning.color)
                } else if index < 9 {
                    Text("⌘\(index + 1)")
                        .font(Design.mono(9.5))
                        .foregroundStyle(Design.theme.faint.color.opacity(selected ? 1 : 0.5))
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(selected ? Design.theme.accent.color.opacity(0.16) : .clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Close terminal", systemImage: "xmark", role: .destructive) {
                Task { await workspace.closeTerminal(session.id) }
            }
        }
    }

    @ViewBuilder private var opener: some View {
        if workspace.box?.awake == true {
            VStack(spacing: 6) {
                Button {
                    Task { await workspace.newTerminal([], cols: 80, rows: 24) }
                } label: {
                    Label("shell", systemImage: "plus")
                }
                .buttonStyle(QuietButtonStyle(wide: true))

                // From the catalogue, filtered by what this box actually has,
                // each started by the argv the catalogue gives it.
                ForEach(workspace.agents) { tool in
                    Button {
                        Task {
                            await workspace.newTerminal(tool.launch ?? [tool.id], cols: 80, rows: 24)
                        }
                    } label: {
                        Label(tool.name, systemImage: "sparkles")
                    }
                    .buttonStyle(QuietButtonStyle(tint: Design.theme.accent.color, wide: true))
                }
            }
            .padding(12)
        }
    }
}

// MARK: - detail

/// One task and every attempt at it, with room to say something back.
private struct TaskDetail: View {
    @ObservedObject var runs: RunsModel
    let task: Asylum.Task

    /// Wide enough for two, and no wider. A run card is a paragraph of text
    /// beside a status; three across a 13-inch iPad leaves each one narrower
    /// than the sentence it has to hold.
    private let columns = [GridItem(.adaptive(minimum: 320, maximum: 520), spacing: 12)]

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(task.title)
                            .font(Design.text(22, .semibold))
                            .foregroundStyle(Design.theme.foreground.color)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        StatusPill(status: task.status, large: true)
                    }

                    if runs.runs.isEmpty {
                        VStack(spacing: 8) {
                            Text("No runs yet")
                                .font(Design.text(16, .medium))
                                .foregroundStyle(Design.theme.foreground.color)
                            Text("Nothing has been dispatched against this task.")
                                .font(Design.text(13))
                                .foregroundStyle(Design.theme.muted.color)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 60)
                    } else {
                        LazyVGrid(columns: columns, alignment: .leading, spacing: 12) {
                            ForEach(runs.runs) { run in
                                RunCard(run: run)
                            }
                        }
                    }
                }
                .padding(20)
            }
            Composer(runs: runs)
        }
    }
}
