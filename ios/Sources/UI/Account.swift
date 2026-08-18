import SwiftUI

/// The account, from the device.
///
/// Nothing here is exotic — a name, a password, a list of what is signed in —
/// and that is rather the point: an app that can run an agent on a machine in
/// another country but cannot change its own password sends you to a laptop
/// for the one task you were least expecting to need one for.
///
/// The device list matters more than it looks. `dpctl` on a laptop, a browser,
/// this iPad and every box's own client all appear here, and revoking one is
/// the whole answer to a device that has gone missing.
struct AccountSheet: View {
    @ObservedObject var workspace: Workspace
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var current = ""
    @State private var next = ""
    @State private var devices: [Control.Device] = []
    @State private var note: String?
    @State private var problem: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                if let problem {
                    Section { Text(problem).font(.system(size: 12)).foregroundColor(.orange) }
                }
                if let note {
                    Section { Text(note).font(.system(size: 12)).foregroundColor(.green) }
                }

                Section("You") {
                    Text(workspace.user?.email ?? "")
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundColor(.gray)
                    TextField("Name", text: $name)
                    Button("Save name") { Task { await saveName() } }
                        .disabled(busy || name.isEmpty || name == workspace.user?.name)
                }

                Section("Change password") {
                    SecureField("Current password", text: $current)
                    SecureField("New password", text: $next)
                    Button("Change it") { Task { await changePassword() } }
                        .disabled(busy || current.isEmpty || next.isEmpty)
                    // Said before it happens rather than discovered afterwards:
                    // this is usually a response to losing control of something,
                    // and the sign-out is the point rather than a side effect.
                    Text("Every other device is signed out, this one included if it is not this session.")
                        .font(.system(size: 11))
                        .foregroundColor(.gray)
                }

                Section("Signed in") {
                    if devices.isEmpty {
                        Text("Loading…").font(.system(size: 12)).foregroundColor(.gray)
                    }
                    ForEach(devices) { device in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(device.label).font(.system(size: 13))
                                Text(device.current ? "this device" : device.ip)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundColor(device.current ? .green : .gray)
                            }
                            Spacer()
                            if !device.current {
                                Button("Sign out") { Task { await revoke(device.id) } }
                                    .font(.system(size: 12))
                                    .disabled(busy)
                            }
                        }
                    }
                    if devices.count > 1 {
                        Button("Sign out everywhere else") { Task { await revokeOthers() } }
                            .foregroundColor(.orange)
                            .disabled(busy)
                    }
                }
            }
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .task {
            name = workspace.user?.name ?? ""
            await loadDevices()
        }
    }

    private func loadDevices() async {
        devices = (try? await workspace.control.devices()) ?? []
    }

    private func run(_ work: () async throws -> Void, said: String) async {
        busy = true
        problem = nil
        note = nil
        do {
            try await work()
            note = said
        } catch {
            problem = error.localizedDescription
        }
        busy = false
    }

    private func saveName() async {
        await run({ workspace.user = try await workspace.control.updateName(name) }, said: "Saved.")
    }

    private func changePassword() async {
        await run(
            {
                try await workspace.control.changePassword(current: current, next: next)
                current = ""
                next = ""
                await loadDevices()
            }, said: "Password changed.")
    }

    private func revoke(_ id: Int) async {
        await run(
            {
                try await workspace.control.revoke(device: id)
                await loadDevices()
            }, said: "Signed out.")
    }

    private func revokeOthers() async {
        await run(
            {
                try await workspace.control.revokeOthers()
                await loadDevices()
            }, said: "Signed out everywhere else.")
    }
}
