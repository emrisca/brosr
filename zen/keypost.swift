// Helper for the shortcut proof. System Events can raise a spawned Zen window
// but leaves the instance inactive, so the page never reads focus. This helper
// activates the exact process id and can post the chord to that process.
//
// Build: swiftc -O keypost.swift -o .runtime/keypost

import AppKit
import CoreGraphics

@main
struct Keypost {
    static func main() {
        let args = CommandLine.arguments
        guard args.count == 3, let pid = pid_t(args[2]) else {
            print("usage: keypost activate|chord|plain <pid>")
            exit(2)
        }
        switch args[1] {
        case "activate":
            exit(activate(pid))
        case "chord":
            exit(chord(pid))
        case "plain":
            exit(plain(pid))
        default:
            print("unknown mode \(args[1])")
            exit(2)
        }
    }

    static func activate(_ pid: pid_t) -> Int32 {
        guard let app = NSRunningApplication(processIdentifier: pid) else {
            print("activate pid=\(pid) ok=0 reason=no-process")
            return 1
        }
        let asked = app.activate(options: [.activateAllWindows])
        var waited = 0
        while !app.isActive && waited < 40 {
            usleep(50_000)
            waited += 1
        }
        print("activate pid=\(pid) asked=\(asked ? 1 : 0) active=\(app.isActive ? 1 : 0)")
        return app.isActive ? 0 : 1
    }

    static func chord(_ pid: pid_t) -> Int32 {
        guard let source = CGEventSource(stateID: .hidSystemState) else {
            print("chord pid=\(pid) ok=0 reason=no-source")
            return 1
        }
        let flags: CGEventFlags = [.maskControl, .maskAlternate]
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 11, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 11, keyDown: false)
        else {
            print("chord pid=\(pid) ok=0 reason=no-event")
            return 1
        }
        down.flags = flags
        up.flags = flags
        down.postToPid(pid)
        usleep(80_000)
        up.postToPid(pid)
        print("chord pid=\(pid) key=11 flags=control,alt trusted=\(AXIsProcessTrusted() ? 1 : 0)")
        return 0
    }

    static func plain(_ pid: pid_t) -> Int32 {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        else {
            print("plain pid=\(pid) ok=0")
            return 1
        }
        down.postToPid(pid)
        up.postToPid(pid)
        print("plain pid=\(pid) key=0")
        return 0
    }
}
