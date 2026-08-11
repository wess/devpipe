import CryptoKit
import Foundation

/// Validates a Devpipe daemon by its certificate fingerprint rather than by a
/// certificate authority.
///
/// The daemon's certificate is self-signed, so the system's trust evaluation
/// will always reject it — correctly, since no CA vouched for it. What matters
/// here is a different question: is this the *same machine* the account was
/// provisioned on? A pinned fingerprint answers that, and answers it more
/// strictly than a CA would. A public CA can be persuaded to issue for a
/// hostname; nobody can produce this key.
///
/// The fingerprint has to arrive over an already-trusted channel — the
/// provisioning API response — or this is theatre. Typing one in by hand, as
/// the spike does, is that channel being a human.
final class PinnedTrust: NSObject, URLSessionDelegate {
    /// Lowercase hex SHA-256 of the leaf certificate's DER encoding. Matches
    /// what `devpiped` prints at startup.
    private let expected: String

    init(fingerprint: String) {
        // Accept the grouped, uppercase form a person copies off a terminal
        // as readily as the bare hex.
        self.expected = fingerprint
            .replacingOccurrences(of: ":", with: "")
            .replacingOccurrences(of: " ", with: "")
            .lowercased()
    }

    var isConfigured: Bool { expected.count == 64 }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        // Refusing to connect at all is the right failure when no pin is set.
        // Falling back to system trust would silently accept any certificate a
        // CA happened to issue for whatever address we dialled.
        guard isConfigured, let leaf = leafCertificate(of: trust) else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        let actual = Self.fingerprint(of: leaf)
        // Constant-time-ish: a fingerprint is public, so this is not a real
        // side channel, but there is no reason to leak the prefix length.
        guard actual.count == expected.count,
              actual.utf8.elementsEqual(expected.utf8)
        else {
            log.error("certificate does not match the pin (got \(actual, privacy: .public))")
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    private func leafCertificate(of trust: SecTrust) -> SecCertificate? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] else {
            return nil
        }
        return chain.first
    }

    static func fingerprint(of certificate: SecCertificate) -> String {
        let der = SecCertificateCopyData(certificate) as Data
        return SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
    }
}
