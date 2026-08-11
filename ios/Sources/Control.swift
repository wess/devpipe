import Foundation

/// The client for devpipe.com — the same API the web app uses.
///
/// The iPad app used to hold a box's address and bearer directly, which made
/// it a terminal emulator that happened to point somewhere. Going through the
/// control plane is what makes it the same product as the web client: one
/// account, one list of boxes, the same wizard catalog, and a session list
/// that agrees no matter which device opened it.
struct Control {
    var baseUrl: URL

    static func fromLaunchArgs() -> Control {
        let args = ProcessInfo.processInfo.arguments
        func value(_ flag: String, _ fallback: String) -> String {
            guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return fallback }
            return args[i + 1]
        }
        return Control(url: value("--server", "https://devpipe.com"))
    }

    init(url: String) {
        baseUrl = URL(string: url) ?? URL(string: "https://devpipe.com")!
    }

    // MARK: - models

    struct User: Codable, Equatable {
        let id: Int
        let email: String
        let username: String
        let name: String
        let is_owner: Bool
    }

    struct Box: Codable, Identifiable, Equatable {
        let id: Int
        let name: String
        let hostname: String
        let status: String
        let status_detail: String
        let ip: String
        let tools: [String]
    }

    struct Connection: Codable {
        let url: String
        let token: String
    }

    struct RemoteSession: Codable, Identifiable, Equatable {
        let id: String
        let argv: [String]
        let cols: Int
        let rows: Int
        let title: String
        let alive: Bool

        var label: String {
            if !title.isEmpty { return title }
            return argv.first.map { URL(fileURLWithPath: $0).lastPathComponent } ?? id
        }
    }

    enum Failure: Error, LocalizedError {
        case message(String)
        var errorDescription: String? {
            switch self {
            case .message(let m): return m
            }
        }
    }

    // MARK: - session token

    /// Kept in the keychain rather than UserDefaults: it is the credential for
    /// the account, not a preference.
    private static let account = "io.wess.devpipe.session"

    static var token: String? {
        get {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrAccount as String: account,
                kSecReturnData as String: true,
            ]
            var out: AnyObject?
            guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
                  let data = out as? Data
            else { return nil }
            return String(data: data, encoding: .utf8)
        }
        set {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrAccount as String: account,
            ]
            SecItemDelete(query as CFDictionary)
            guard let value = newValue?.data(using: .utf8) else { return }
            var add = query
            add[kSecValueData as String] = value
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    // MARK: - transport

    private func send<T: Decodable>(
        _ method: String,
        _ path: String,
        body: [String: Any]? = nil,
        as: T.Type
    ) async throws -> T {
        var req = URLRequest(url: baseUrl.appendingPathComponent(path))
        req.httpMethod = method
        if let token = Control.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw Failure.message("The server did not answer.")
        }
        if !(200..<300).contains(http.statusCode) {
            // A dead session returns the user to sign-in rather than showing an
            // error they can do nothing about.
            if http.statusCode == 401 { Control.token = nil }
            let detail =
                (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"]
                as? String
            throw Failure.message(detail ?? "Request failed (\(http.statusCode)).")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: - api

    struct AuthState: Codable { let needs_owner: Bool }
    struct AuthResult: Codable { let token: String; let user: User }
    struct MeResult: Codable { let user: User }

    func authState() async throws -> AuthState {
        try await send("GET", "/api/auth/state", as: AuthState.self)
    }

    func signIn(email: String, password: String) async throws -> User {
        let out = try await send(
            "POST", "/api/auth/login", body: ["email": email, "password": password],
            as: AuthResult.self)
        Control.token = out.token
        return out.user
    }

    func register(email: String, username: String, name: String, password: String) async throws
        -> User
    {
        let out = try await send(
            "POST", "/api/auth/register",
            body: ["email": email, "username": username, "name": name, "password": password],
            as: AuthResult.self)
        Control.token = out.token
        return out.user
    }

    func me() async throws -> User {
        try await send("GET", "/api/auth/me", as: MeResult.self).user
    }

    func signOut() async {
        _ = try? await send("POST", "/api/auth/logout", as: [String: Bool].self)
        Control.token = nil
    }

    func boxes() async throws -> [Box] {
        try await send("GET", "/api/boxes", as: [Box].self)
    }

    func connection(box: Int) async throws -> Connection {
        try await send("GET", "/api/boxes/\(box)/connection", as: Connection.self)
    }

    func sessions(box: Int) async throws -> [RemoteSession] {
        try await send("GET", "/api/boxes/\(box)/sessions", as: [RemoteSession].self)
    }

    func createSession(box: Int, argv: [String], cols: Int, rows: Int) async throws
        -> RemoteSession
    {
        try await send(
            "POST", "/api/boxes/\(box)/sessions",
            body: ["argv": argv, "cols": cols, "rows": rows], as: RemoteSession.self)
    }

    func killSession(box: Int, id: String) async throws {
        _ = try? await send("DELETE", "/api/boxes/\(box)/sessions/\(id)", as: [String: Bool].self)
    }
}
