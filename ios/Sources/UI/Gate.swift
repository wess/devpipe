import SwiftUI

/// Sign in. Deliberately the same copy as the web client's gate.
///
/// The old one was a stack of `.roundedBorder` fields floating in the middle of
/// a thirteen-inch screen, which on a dark background renders as a light-mode
/// box: the first thing anyone saw of this product looked like a test harness.
struct Gate: View {
    @ObservedObject var workspace: Workspace

    @State private var needsOwner = false
    @State private var inviteRequired = false
    @State private var registering = false
    @State private var invite = ""
    @State private var email = ""
    @State private var username = ""
    @State private var name = ""
    @State private var password = ""
    @State private var error: String?
    @State private var sent: String?
    @State private var busy = false
    @FocusState private var focus: Field?

    private enum Field { case email, username, name, password, invite }

    private var creating: Bool { registering || needsOwner }

    var body: some View {
        ZStack {
            Design.theme.background.color.ignoresSafeArea()
            // A scroll view sizes its content to fit, so spacers inside one
            // collapse to their minimum and the card lands against the top of a
            // thirteen-inch screen. Giving the stack the viewport's own height
            // is what lets them push it to the middle, while still scrolling
            // when the keyboard leaves no room.
            GeometryReader { viewport in
                ScrollView {
                    VStack(spacing: 0) {
                        Spacer(minLength: 24)
                        card
                        Spacer(minLength: 24)
                    }
                    .frame(maxWidth: .infinity, minHeight: viewport.size.height)
                }
                .scrollDismissesKeyboard(.interactively)
            }
        }
        .task {
            guard let state = try? await workspace.control.authState() else { return }
            needsOwner = state.needs_owner
            inviteRequired = state.invite_required
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 16) {
            header

            if needsOwner {
                notice(
                    "This instance has no owner yet. The first account created becomes the owner.",
                    tint: Design.theme.accent.color, icon: "crown")
            }
            if let error {
                notice(error, tint: Design.theme.warning.color, icon: "exclamationmark.triangle")
            }
            if let sent {
                notice(sent, tint: Design.theme.good.color, icon: "envelope")
            }

            VStack(spacing: 10) {
                TextField("Email", text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .email)
                    .submitLabel(creating ? .next : .go)

                if creating {
                    TextField("Username", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .username)
                        .submitLabel(.next)
                    TextField("Name", text: $name)
                        .focused($focus, equals: .name)
                        .submitLabel(.next)
                    // Asked for up front rather than after a whole form has
                    // been filled in and refused. Without this the button could
                    // only ever fail.
                    if inviteRequired && !needsOwner {
                        TextField("Invite code", text: $invite)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focus, equals: .invite)
                            .submitLabel(.next)
                    }
                }

                SecureField("Password", text: $password)
                    .textContentType(creating ? .newPassword : .password)
                    .focused($focus, equals: .password)
                    .submitLabel(.go)
            }
            .textFieldStyle(FieldStyle())
            .onSubmit(advance)

            Button(busy ? "…" : creating ? "Create account" : "Sign in") {
                Task { await submit() }
            }
            .buttonStyle(FilledButtonStyle(wide: true))
            .disabled(busy || email.isEmpty || password.isEmpty)

            if !needsOwner {
                HStack {
                    Button(registering ? "I already have an account" : "Create an account") {
                        withAnimation(.easeOut(duration: 0.15)) {
                            registering.toggle()
                            error = nil
                            sent = nil
                        }
                    }
                    .font(Design.text(13))
                    Spacer()
                    // The link goes to a browser, so only the asking half lives
                    // here — but without it a forgotten password meant finding
                    // a laptop, which is the one thing this app exists to
                    // avoid.
                    if !registering {
                        Button("Forgot password?") { Task { await forgot() } }
                            .font(Design.text(13))
                            .foregroundStyle(Design.theme.muted.color)
                            .disabled(busy || email.isEmpty)
                    }
                }
            }
        }
        .padding(28)
        .frame(maxWidth: 380)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Design.theme.surface.color)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Design.theme.border.color, lineWidth: 1)
        )
        .padding(.horizontal, 24)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 9) {
                Image(systemName: "terminal.fill")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(Design.theme.accent.color)
                Text("Devpipe")
                    .font(Design.text(19, .semibold))
                    .foregroundStyle(Design.theme.foreground.color)
            }
            Text("Your machine, and the agents on it, from here.")
                .font(Design.text(13))
                .foregroundStyle(Design.theme.muted.color)
        }
        .padding(.bottom, 2)
    }

    private func notice(_ text: String, tint: Color, icon: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).font(.system(size: 11, weight: .semibold))
            Text(text).font(Design.text(12.5))
        }
        .foregroundStyle(tint)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous).fill(tint.opacity(0.1))
        )
    }

    private func advance() {
        switch focus {
        case .email: focus = creating ? .username : .password
        case .username: focus = .name
        case .name: focus = inviteRequired && !needsOwner ? .invite : .password
        case .invite: focus = .password
        default: Task { await submit() }
        }
    }

    private func forgot() async {
        busy = true
        error = nil
        // Answers the same whether or not the address is registered, and says
        // so in those terms: "if there is an account" is the honest phrasing
        // and it is also what stops this being a way to test addresses.
        try? await workspace.control.forgotPassword(email: email)
        sent = "If there is an account for \(email), a reset link is on its way."
        busy = false
    }

    private func submit() async {
        guard !busy, !email.isEmpty, !password.isEmpty else { return }
        busy = true
        error = nil
        focus = nil
        do {
            let user =
                creating
                ? try await workspace.control.register(
                    email: email, username: username, name: name, password: password,
                    invite: invite)
                : try await workspace.control.signIn(email: email, password: password)
            workspace.user = user
            Notifier.requestPermission()
            await workspace.loadCatalog()
            await workspace.refreshBoxes()
        } catch {
            self.error = error.localizedDescription
        }
        busy = false
    }
}
