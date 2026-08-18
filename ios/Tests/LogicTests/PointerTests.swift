import XCTest

@testable import DevpipeLogic

/// The pointer, which the iPad client used not to send at all.
///
/// A full-screen program runs on the alternate screen, the alternate screen
/// keeps no scrollback, and the client only knew how to move through
/// scrollback — so inside the one kind of program this product exists to run,
/// the wheel and the trackpad did nothing.
final class MouseTests: XCTestCase {
    /// ?1000 click reporting plus ?1006 SGR, which is what anything modern asks
    /// for.
    private let sgr = TerminalModes(raw: 16 | 128)
    /// ?1000 alone: the X10 encoding, still what some programs negotiate.
    private let x10 = TerminalModes(raw: 16)
    /// Alternate screen with ?1007 alternate scroll, and nothing reading the
    /// mouse — a pager.
    private let pager = TerminalModes(raw: 8 | 256)
    private let plain = TerminalModes(raw: 0)

    private func text(_ data: Data?) -> String? {
        data.map { String(decoding: $0, as: UTF8.self) }
    }

    func testNothingIsSentWhenNobodyAsked() {
        XCTAssertNil(Mouse.report(plain, button: 0, col: 3, row: 4, pressed: true))
    }

    func testSgrEncodesOneBasedCoordinates() {
        XCTAssertEqual(text(Mouse.report(sgr, button: 0, col: 0, row: 0, pressed: true)), "\u{1b}[<0;1;1M")
        XCTAssertEqual(
            text(Mouse.report(sgr, button: 0, col: 41, row: 9, pressed: false)), "\u{1b}[<0;42;10m")
    }

    func testModifiersBiasTheButton() {
        XCTAssertEqual(
            text(
                Mouse.report(
                    sgr, button: 0, col: 0, row: 0, pressed: true,
                    modifiers: Mouse.Modifiers(shift: true))), "\u{1b}[<4;1;1M")
        XCTAssertEqual(
            text(
                Mouse.report(
                    sgr, button: 0, col: 0, row: 0, pressed: true,
                    modifiers: Mouse.Modifiers(control: true))), "\u{1b}[<16;1;1M")
    }

    func testX10RefusesCoordinatesItCannotExpress() {
        // X10 packs a coordinate as `32 + n` into one byte, so it cannot say
        // anything past column 223. On a terminal this wide that is most of the
        // screen, and the failure mode is a click landing somewhere else
        // entirely rather than an error.
        XCTAssertNotNil(Mouse.report(x10, button: 0, col: 100, row: 4, pressed: true))
        XCTAssertNil(Mouse.report(x10, button: 0, col: 300, row: 4, pressed: true))
    }

    func testX10HasNoReleaseButton() {
        let release = Mouse.report(x10, button: 0, col: 1, row: 1, pressed: false)
        let expected: [UInt8] = [0x1b, 0x5b, 0x4d, 32 + 3, 32 + 2, 32 + 2]
        XCTAssertEqual([UInt8](release!), expected)
    }

    func testWheelGoesToTheProgramWhenItIsReadingTheMouse() {
        guard case .send(let bytes) = Mouse.wheel(sgr, lines: -1, col: 0, row: 0, hasScrollback: true)
        else { return XCTFail("expected a report") }
        XCTAssertEqual(String(decoding: bytes, as: UTF8.self), "\u{1b}[<64;1;1M")
    }

    func testWheelBecomesArrowKeysOnTheAlternateScreen() {
        // There is no scrollback to move through, so the wheel has to become
        // something the program understands. Three rows a notch is xterm's
        // ratio and what the programs reading them are tuned for.
        guard case .send(let bytes) = Mouse.wheel(pager, lines: -1, col: 0, row: 0, hasScrollback: false)
        else { return XCTFail("expected arrow keys") }
        XCTAssertEqual(String(decoding: bytes, as: UTF8.self), "\u{1b}[A\u{1b}[A\u{1b}[A")
    }

    func testAlternateScreenArrowsRespectApplicationCursorMode() {
        // Getting this wrong makes the wheel dead again, in a way that looks
        // identical to sending nothing.
        let appPager = TerminalModes(raw: 1 | 8 | 256)
        guard case .send(let bytes) = Mouse.wheel(appPager, lines: 1, col: 0, row: 0, hasScrollback: false)
        else { return XCTFail("expected arrow keys") }
        XCTAssertEqual(String(decoding: bytes, as: UTF8.self), "\u{1b}OB\u{1b}OB\u{1b}OB")
    }

    func testAlternateScreenWithoutAlternateScrollDoesNothing() {
        let noScroll = TerminalModes(raw: 8)
        XCTAssertEqual(Mouse.wheel(noScroll, lines: -1, col: 0, row: 0, hasScrollback: false), .ignore)
    }

    func testOtherwiseTheWheelMovesLocalHistory() {
        XCTAssertEqual(
            Mouse.wheel(plain, lines: -3, col: 0, row: 0, hasScrollback: true),
            .scrollback(lines: -3))
        XCTAssertEqual(
            Mouse.wheel(plain, lines: -3, col: 0, row: 0, hasScrollback: false), .ignore,
            "nothing to scroll through")
    }

    func testMotionIsOnlySentToProgramsThatWantIt() {
        let drag = TerminalModes(raw: 32 | 128)  // ?1002
        XCTAssertNil(Mouse.motion(drag, button: 0, col: 1, row: 1, held: false), "no button down")
        XCTAssertNotNil(Mouse.motion(drag, button: 0, col: 1, row: 1, held: true))

        let motion = TerminalModes(raw: 64 | 128)  // ?1003
        XCTAssertNotNil(
            Mouse.motion(motion, button: 0, col: 1, row: 1, held: false), "hover counts here")
    }
}

/// The rules that decide what a finger meant. Shared, deliberately, with the
/// web client's `touch.ts`.
final class GestureTests: XCTestCase {
    private let origin = CGPoint(x: 100, y: 100)

    func testAStillFingerIsUndecidedUntilTheLongPress() {
        XCTAssertEqual(
            Gestures.classify(.pending, from: origin, to: origin, elapsed: 0.1), .pending)
        XCTAssertEqual(
            Gestures.classify(.pending, from: origin, to: origin, elapsed: 0.6), .select)
    }

    func testMovingBeyondTheSlopIsAScroll() {
        let moved = CGPoint(x: 100, y: 140)
        XCTAssertEqual(Gestures.classify(.pending, from: origin, to: moved, elapsed: 0.1), .scroll)
    }

    func testSmallWanderIsStillATap() {
        // A finger resting on glass moves several points without its owner
        // intending anything, and a tap read as a one-point scroll leaves the
        // keyboard closed with no indication why.
        let wandered = CGPoint(x: 104, y: 103)
        XCTAssertTrue(Gestures.wasTap(.pending, from: origin, to: wandered, elapsed: 0.1))
        XCTAssertFalse(Gestures.wasTap(.pending, from: origin, to: wandered, elapsed: 0.8))
        XCTAssertFalse(Gestures.wasTap(.scroll, from: origin, to: wandered, elapsed: 0.1))
    }

    func testACommittedGestureNeverChangesItsMind() {
        // A long press that became a selection stays one even when the finger
        // later travels, or dragging to extend past a few characters would turn
        // into a scroll and lose the selection.
        let far = CGPoint(x: 400, y: 400)
        XCTAssertEqual(Gestures.classify(.select, from: origin, to: far, elapsed: 2), .select)
        XCTAssertEqual(Gestures.classify(.pointer, from: origin, to: far, elapsed: 2), .pointer)
    }

    func testSlowDragsCarryTheirRemainderForward() {
        // Without this a slow drag scrolls nothing at all: each event moves a
        // few points, every one rounds to zero rows, and the content sits still
        // under a finger that is plainly moving.
        var carried: CGFloat = 0
        var total = 0
        for _ in 0..<10 {
            let (rows, remainder) = Gestures.rows(forDrag: carried + 4, cellHeight: 17)
            carried = remainder
            total += rows
        }
        XCTAssertEqual(total, 2, "40 points of drag over a 17-point cell is two rows")
    }

    func testDragDirection() {
        // Positive dy is a finger moving down, which drags content down, which
        // means going back through history.
        XCTAssertEqual(Gestures.rows(forDrag: 34, cellHeight: 17).rows, 2)
        XCTAssertEqual(Gestures.rows(forDrag: -34, cellHeight: 17).rows, -2)
        XCTAssertEqual(Gestures.rows(forDrag: 34, cellHeight: 0).rows, 0, "no divide by zero")
    }
}

/// Colour packing, which the GPU reads directly and which is therefore silent
/// when wrong: the text simply comes out the wrong colour.
final class ThemeTests: XCTestCase {
    func testPackingIsRgbaLowByteFirst() {
        // `unpack_unorm4x8_to_float` on the GPU side reads x from the low byte.
        let red = RGBA(0xFF_00_00)
        XCTAssertEqual(red.packed & 0xFF, 255, "red in the low byte")
        XCTAssertEqual((red.packed >> 24) & 0xFF, 255, "opaque")

        let blue = RGBA(0x00_00_FF)
        XCTAssertEqual((blue.packed >> 16) & 0xFF, 255)
    }

    func testDefaultTagsResolveToTheThemeNotToBlack() {
        let theme = Theme.dark
        XCTAssertEqual(theme.resolve(0, isForeground: true), theme.foreground)
        XCTAssertEqual(theme.resolve(0, isForeground: false), theme.background)
    }

    func testIndexedAndTruecolorTags() {
        let theme = Theme.dark
        // tag 1 = 256-colour index.
        XCTAssertEqual(theme.resolve((1 << 24) | 33, isForeground: true), theme.ansi[33])
        // tag 2 = 24-bit rgb.
        XCTAssertEqual(
            theme.resolve((2 << 24) | (0x12 << 16) | (0x34 << 8) | 0x56, isForeground: true),
            RGBA(0x12_34_56))
    }

    func testAnIndexPastTheTableCannotCrash() {
        // The emulator should never emit one, but a renderer that trusts an
        // index out of a byte and indexes an array with it is one malformed
        // escape away from a crash.
        XCTAssertEqual(Theme.dark.resolve((1 << 24) | 255, isForeground: true), Theme.dark.ansi[255])
    }

    func testTheTableCoversAllTwoHundredAndFiftySix() {
        XCTAssertEqual(Theme.dark.ansi.count, 256)
    }
}
