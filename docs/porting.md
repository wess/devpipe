# Porting the client

Written while rebuilding the iPad client, so the split below is what the code
actually is rather than what it might be arranged into later.

There are now three clients — the web terminal, the iPad app, and `dpctl` —
and they share one terminal emulator. That is the whole point of the
arrangement and the reason a fourth (Android) is a UI project rather than a
terminal project.

## What is already shared

**The emulator.** `core/` is a C ABI over sinclair's `vt` crate, built as a
`staticlib` for iOS, a `cdylib`/wasm for the browser, and an `rlib` for tests.
Nothing in it is Apple-specific — `cargo check --target
x86_64-unknown-linux-gnu` passes — and nothing in it should become so. Every
capability the clients need is behind this ABI: the grid snapshot, damage,
scrollback, selection, links, search, and the one-shot events (bell, title,
cwd, OSC 52 clipboard, OSC 9 notifications).

**The wire protocol.** Binary websocket frames are raw pty bytes in both
directions; text frames are JSON control messages (`hello`, `resize`,
`resync`, `exit`). The server interprets none of it, because each client runs
its own emulator. This is what buys local echo: a keystroke paints before the
round trip rather than after it.

**The input encoders.** `ios/Sources/Core/{Keys,Mouse,Gestures,Modes}.swift`
and `src/web/terminal/{keys,mouse,touch}.ts` are the same arithmetic written
twice, which is one time too many and the obvious next thing to move into
`core/`. They are also the highest-value thing to port carefully: a wrong
escape sequence is not an error anywhere in the stack, so the key just does
nothing, inside one program, in one mode. `ios/Tests/LogicTests` exists for
exactly this reason and its cases transfer verbatim.

## What is per-platform, and has to be

**The renderer.** The iPad draws with Metal: a shelf-packed glyph atlas, one
instanced quad pass for solid fills and one for glyphs, ~90 lines of shader.
The design ports directly to Vulkan or GLES — the atlas, the instance formats
and the draw order are all API-agnostic, and `TerminalFrame` is deliberately
expressed in *cell* coordinates so the renderer owns every pixel decision.
An Android port rewrites `TerminalRenderer.swift` and `GlyphAtlas.swift`
against `android.graphics`/GLES and keeps the shape.

**The frame pump.** `Engine.swift` owns the emulator on one serial queue,
parses off the main thread, coalesces incoming bytes, honours synchronized
output (`?2026`), and publishes a frame only when the emulator reports damage.
The concurrency primitives differ on Android (a `HandlerThread`, or a
coroutine dispatcher) but the rules do not, and two of them are load-bearing:

- Only one thread may ever be inside the emulator. Every entry point takes
  `&mut` on the Rust side, so two threads in it at once is undefined
  behaviour rather than a race you get away with.
- `take_damage` **drains**. Any path that asks what changed and then declines
  to draw has destroyed the only record that anything did.

**The shell.** Sidebar, boxes, account, the build log. Ordinary platform UI.

## Android: what already works

`core/android.sh` builds the emulator as a shared library for all three ABIs
and lays them out the way Gradle wants:

    core/build/android/{arm64-v8a,armeabi-v7a,x86_64}/libdevpipecore.so

Point an app module's `jniLibs.srcDirs` at `core/build/android` and
`System.loadLibrary("devpipecore")` finds it. The full C ABI is exported —
`llvm-nm -D` on the arm64 build lists every `dp_term_*` symbol — so the
emulator, its scrollback, selection, search and events are all reachable from
Kotlin today.

Needs `brew install --cask android-ndk` and
`rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android`.

## Android: what is not written

1. **A JNI shim.** It should be thin to the point of being boring: the same
   functions, with `JNIEnv` marshalling and a `long` holding the `DpTerm*`.
   The snapshot must come back as a direct `ByteBuffer` over the Rust buffer
   rather than a copied array, for the same reason Swift borrows it — per-cell
   calls across the boundary cost more than the emulation does.
2. **A renderer.** `Paint.getTextBounds` into a `Bitmap` into a GL texture is
   the direct analogue of what `GlyphAtlas.swift` does with CoreText.
3. **Everything above the emulator.** The transport, the shell, the input
   handling.

None of that exists, and nothing here should be read as a claim that it does.
What has been established is only that the emulator is genuinely portable and
that the build proves it rather than a comment asserting it.
