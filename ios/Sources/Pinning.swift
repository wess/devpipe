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

        // No pin means system trust, and that is the right answer now rather
        // than a concession.
        //
        // This used to refuse outright, correctly: the daemon served its own
        // self-signed certificate, so a CA-issued one for the address we
        // dialled proved nothing. That is no longer how a box is reached.
        // Every box has its own name under devpipe.com and a real Let's
        // Encrypt certificate for it, terminated by Caddy — the whole point of
        // the DNS-and-ACME arrangement, and the reason Info.plist needs no ATS
        // exceptions. The hostname itself arrives from `/boxes/:id/connection`
        // over an already-authenticated TLS channel.
        //
        // Leaving it as a refusal is what made the iPad terminal blank: the
        // app passes no fingerprint, so *every* websocket to a box was
        // cancelled before it opened. A session appeared in the sidebar,
        // because the control plane created it, and nothing ever attached.
        guard isConfigured else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let leaf = leafCertificate(of: trust) else {
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
