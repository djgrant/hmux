import Foundation

// Owns and supervises the humans.sh server as a child process. The brief wants
// the server up whenever the human is at their Mac; the app is that owner. The
// app is already mandatory for the product (notifications come from it), so its
// lifetime bounds the server's — a supervised child is the right model, not a
// launchd agent that could outlive the notifier. This class adds the one thing
// launchd would have given us for free: restart-on-crash.
// All mutable state is confined to `queue`, so the unchecked conformance is
// sound — it exists only to satisfy @Sendable termination-handler closures.
final class ServerProcess: @unchecked Sendable {
    private var process: Process?
    private let queue = DispatchQueue(label: "sh.humans.server")

    // Desired state + how to satisfy it, so the supervisor can relaunch after a
    // crash without the caller re-issuing start().
    private var wantRunning = false
    private var repoPath = ""
    private var port = defaultPort

    // Crash-loop backoff. Reset once a launch survives long enough to look
    // healthy; grows (capped) when the server dies quickly and repeatedly.
    private var backoff: TimeInterval = 1
    private static let maxBackoff: TimeInterval = 30
    private static let healthyUptime: TimeInterval = 10

    var onStateChange: (() -> Void)?

    var isRunning: Bool {
        queue.sync { process?.isRunning ?? false }
    }

    // Resolve `bun` from common install locations, since a GUI app doesn't
    // inherit the user's shell PATH.
    private func bunPath() -> String? {
        let candidates = [
            "\(NSHomeDirectory())/.bun/bin/bun",
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun"
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    func start(repoPath: String, port: Int) {
        queue.sync {
            self.repoPath = repoPath
            self.port = port
            self.wantRunning = true
            self.backoff = 1
            self.launchLocked()
        }
        onStateChange?()
    }

    func stop() {
        queue.sync {
            wantRunning = false
            // Detach our handler first so an intentional terminate() doesn't
            // look like a crash and trigger a relaunch.
            process?.terminationHandler = nil
            process?.terminate()
            process = nil
        }
        onStateChange?()
    }

    // Must be called on `queue`. Spawns the server and wires up supervision.
    private func launchLocked() {
        guard wantRunning, process?.isRunning != true else { return }
        guard let bun = bunPath() else {
            NSLog("humans.sh: bun not found; cannot start server")
            wantRunning = false
            return
        }
        let entry = "\(repoPath)/packages/server/src/index.ts"
        guard FileManager.default.fileExists(atPath: entry) else {
            NSLog("humans.sh: server entry not found at \(entry)")
            wantRunning = false
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bun)
        p.arguments = ["run", entry]
        p.currentDirectoryURL = URL(fileURLWithPath: "\(repoPath)/packages/server")
        var env = ProcessInfo.processInfo.environment
        env["HUMANS_PORT"] = String(port)
        p.environment = env

        let startedAt = Date()
        p.terminationHandler = { [weak self] proc in
            guard let self else { return }
            self.queue.async {
                // Ignore stale handlers from a process we've already replaced.
                guard self.process === proc else { return }
                self.process = nil
                self.handleExitLocked(uptime: Date().timeIntervalSince(startedAt),
                                      status: proc.terminationStatus)
            }
            self.onStateChange?()
        }

        do {
            try p.run()
            process = p
        } catch {
            NSLog("humans.sh: failed to launch server: \(error.localizedDescription)")
            scheduleRestartLocked()
        }
    }

    // Must be called on `queue`. Decides whether an exit was a crash worth
    // restarting, and backs off if the server is flapping.
    private func handleExitLocked(uptime: TimeInterval, status: Int32) {
        guard wantRunning else { return }
        if uptime >= Self.healthyUptime {
            backoff = 1 // a healthy run resets the penalty
        }
        NSLog("humans.sh: server exited (status \(status), up \(Int(uptime))s); restarting in \(backoff)s")
        scheduleRestartLocked()
    }

    // Must be called on `queue`.
    private func scheduleRestartLocked() {
        let delay = backoff
        backoff = min(backoff * 2, Self.maxBackoff)
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.wantRunning else { return }
            self.launchLocked()
            self.onStateChange?()
        }
    }
}
