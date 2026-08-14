import SwiftUI

/// Making a box, from the device you are holding.
///
/// Until now the empty state said "Set one up on devpipe.com", which is a
/// reasonable thing to say to somebody who already has a laptop open and a
/// strange thing to say to somebody who bought an iPad to avoid opening one.
/// It also meant a beta invite could not be taken up on the device the product
/// is most interesting on.
///
/// Everything here has a server-side default. A person who opens this, types
/// nothing and taps Create gets a working machine, and the wizard's job is to
/// let them do better than that rather than to interrogate them first.
struct NewBoxSheet: View {
    @ObservedObject var workspace: Workspace
    let onDone: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var spec = Control.NewBox()
    @State private var busy = false
    @State private var error: String?

    /// Agents first, because an agent is the reason to have one of these.
    /// Runtimes and tooling follow; a service is a deliberate choice nobody
    /// makes by accident.
    private var groups: [(String, [Control.Tool])] {
        let order = ["agent", "runtime", "tooling", "service"]
        return order.compactMap { group in
            let tools = workspace.catalog.filter { $0.group == group }
            return tools.isEmpty ? nil : (group, tools)
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                if let error {
                    Section {
                        Text(error)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundColor(.orange)
                    }
                }

                Section("Name") {
                    TextField("work", text: $spec.name)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                }

                Section("Where and how big") {
                    Picker("Region", selection: $spec.region) {
                        ForEach(workspace.regions) { region in
                            Text(region.label).tag(region.slug)
                        }
                    }
                    Picker("Size", selection: $spec.size) {
                        ForEach(workspace.sizes) { size in
                            // The price is the part people actually choose on,
                            // and hiding it until the invoice is the wrong way
                            // round.
                            Text("\(size.label) · $\(size.monthly)/mo").tag(size.slug)
                        }
                    }
                }

                Section("Shell") {
                    Picker("Shell", selection: $spec.shell) {
                        Text("bash").tag("bash")
                        Text("zsh").tag("zsh")
                        Text("fish").tag("fish")
                    }
                    .pickerStyle(.segmented)
                }

                ForEach(groups, id: \.0) { group, tools in
                    Section(group == "agent" ? "Agents" : group.capitalized) {
                        ForEach(tools) { tool in
                            Toggle(
                                tool.name,
                                isOn: Binding(
                                    get: { spec.tools.contains(tool.id) },
                                    set: { on in
                                        if on {
                                            if !spec.tools.contains(tool.id) { spec.tools.append(tool.id) }
                                        } else {
                                            spec.tools.removeAll { $0 == tool.id }
                                        }
                                    }
                                )
                            )
                            .font(.system(size: 14))
                        }
                    }
                }

                Section {
                    Text(
                        "The machine takes about three minutes to build. "
                            + "You can watch it, or come back to it."
                    )
                    .font(.system(size: 12))
                    .foregroundColor(.gray)
                }
            }
            .navigationTitle("New box")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Creating…" : "Create") { Task { await create() } }
                        .disabled(busy)
                }
            }
        }
        .task {
            // The catalogue may not have arrived yet on a cold start, and a
            // wizard with empty pickers is worse than one that waits.
            if workspace.catalog.isEmpty { await workspace.loadCatalog() }
            if spec.region.isEmpty { spec.region = workspace.regions.first?.slug ?? "" }
            if spec.size.isEmpty { spec.size = workspace.sizes.first?.slug ?? "" }
            if spec.tools.isEmpty { spec.tools = workspace.defaultTools }
        }
    }

    private func create() async {
        busy = true
        error = nil
        do {
            let made = try await workspace.create(spec)
            // Straight to the new box, so the build log is what you see next
            // rather than a list you have to find it in.
            workspace.selectedBox = made.id
            onDone()
            dismiss()
        } catch {
            // The server's own sentence — "You already have 3 boxes", "No
            // provider is configured yet" — is the one worth reading.
            self.error = error.localizedDescription
        }
        busy = false
    }
}
