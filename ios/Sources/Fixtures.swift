import Foundation

/// Byte sources that need no daemon. These are the render spike's harness and
/// they stay because they are the only way to measure the renderer against a
/// fixed input — a live session is never the same twice.

/// Replays a captured stream in chunks, imitating a pty that delivers output
/// in bursts rather than all at once.
final class FixtureSource: ByteSource {
    var onBytes: ((Data) -> Void)?
    private let data: Data
    private let chunk: Int
    private let interval: TimeInterval
    private var offset = 0
    private var timer: Timer?
    private let loops: Bool

    init(data: Data, chunk: Int = 2048, interval: TimeInterval = 1.0 / 120.0, loops: Bool = false) {
        // A captured full-screen TUI ends by tearing its own screen down:
        // vim's last act is to leave the alt screen, which correctly leaves a
        // blank terminal and nothing to look at. Stop there so the fixture
        // holds its painted frame.
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

    func start() {
        stop()
        offset = 0
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] t in
            guard let self else { return }
            if offset >= data.count {
                if loops { offset = 0 } else { t.invalidate(); return }
            }
            let end = min(offset + chunk, data.count)
            onBytes?(data.subdata(in: offset..<end))
            offset = end
        }
    }

    func stop() { timer?.invalidate(); timer = nil }
    func send(_ data: Data) {}
    func resize(cols: Int, rows: Int) {}
}

/// Worst case: every cell a different color, every frame. Real TUIs never do
/// this, which is the point — it bounds the renderer from above.
final class StressSource: ByteSource {
    var onBytes: ((Data) -> Void)?
    var cols = 80
    var rows = 24
    private var timer: Timer?
    private var tick = 0

    func start() {
        stop()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            var s = "\u{1b}[H"
            let glyphs = Array("abcdefghijklmnopqrstuvwxyz0123456789/\\|-+=[]{}<>#@$%&*")
            for r in 0..<rows {
                s += "\u{1b}[\(r + 1);1H"
                for c in 0..<cols {
                    let n = (r &* 31 &+ c &* 17 &+ tick) & 0xFF
                    s += "\u{1b}[38;5;\(n)m"
                    s.append(glyphs[(r &+ c &+ tick) % glyphs.count])
                }
            }
            tick &+= 1
            onBytes?(Data(s.utf8))
        }
    }

    func stop() { timer?.invalidate(); timer = nil }
    func send(_ data: Data) {}
    func resize(cols: Int, rows: Int) { self.cols = cols; self.rows = rows }
}
