import Foundation

/// Byte sources that need no daemon.
///
/// These are the renderer's harness, and they earn their place: a live session
/// is never the same twice, so it cannot tell you whether a change made drawing
/// faster or slower. They also mean the terminal can be worked on end to end
/// without an account, a box, or a network.
///
/// Reachable with `--fixture stress`, `--fixture vim` or `--fixture top`.

/// Replays a captured stream in chunks, imitating a pty that delivers output in
/// bursts rather than all at once.
final class FixtureSource: ByteSource {
    var onBytes: ((Data) -> Void)?
    var onState: ((TransportState) -> Void)?

    private let data: Data
    private let chunk: Int
    private let interval: TimeInterval
    private var offset = 0
    private var timer: Timer?
    private let loops: Bool

    init(data: Data, chunk: Int = 2048, interval: TimeInterval = 1.0 / 120.0, loops: Bool = false) {
        // A captured full-screen TUI ends by tearing its own screen down: vim's
        // last act is to leave the alt screen, which correctly leaves a blank
        // terminal and nothing to look at. Stop there so the fixture holds its
        // painted frame.
        let altScreenExit = Data("\u{1b}[?1049l".utf8)
        if let exit = data.range(of: altScreenExit) {
            self.data = data.subdata(in: data.startIndex..<exit.lowerBound)
        } else {
            self.data = data
        }
        self.chunk = chunk
        self.interval = interval
        self.loops = loops
    }

    /// One of the captures in the bundle, by name.
    convenience init?(named name: String, loops: Bool = false) {
        guard let url = Bundle.main.url(forResource: name, withExtension: "raw"),
            let data = try? Data(contentsOf: url)
        else { return nil }
        self.init(data: data, loops: loops)
    }

    func start() {
        stop()
        offset = 0
        onState?(.attached("fixture"))
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] t in
            guard let self else { return }
            if offset >= data.count {
                if loops {
                    offset = 0
                } else {
                    t.invalidate()
                    return
                }
            }
            let end = min(offset + chunk, data.count)
            onBytes?(data.subdata(in: offset..<end))
            offset = end
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }
    func send(_ data: Data) {}
    func resize(cols: Int, rows: Int) {}
}

/// Worst case: every cell a different colour, every frame. Real TUIs never do
/// this, which is the point — it bounds the renderer from above.
final class StressSource: ByteSource {
    var onBytes: ((Data) -> Void)?
    var onState: ((TransportState) -> Void)?

    private var cols = 80
    private var rows = 24
    private var timer: Timer?
    private var tick = 0

    func start() {
        stop()
        onState?(.attached("stress"))
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            var out = "\u{1b}[H"
            let glyphs = Array("abcdefghijklmnopqrstuvwxyz0123456789/\\|-+=[]{}<>#@$%&*")
            for r in 0..<rows {
                out += "\u{1b}[\(r + 1);1H"
                for c in 0..<cols {
                    let n = (r &* 31 &+ c &* 17 &+ tick) & 0xFF
                    out += "\u{1b}[38;5;\(n)m"
                    out.append(glyphs[(r &+ c &+ tick) % glyphs.count])
                }
            }
            tick &+= 1
            onBytes?(Data(out.utf8))
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }
    func send(_ data: Data) {}

    func resize(cols: Int, rows: Int) {
        self.cols = cols
        self.rows = rows
    }
}

enum Fixtures {
    /// What `--fixture <name>` asked for, if anything.
    static func fromLaunchArgs() -> ByteSource? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "--fixture"), i + 1 < args.count else { return nil }
        switch args[i + 1] {
        case "stress": return StressSource()
        case let name: return FixtureSource(named: name, loops: true)
        }
    }
}
