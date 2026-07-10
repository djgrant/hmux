import Foundation

// A thin read-only WebSocket client. The app subscribes to the same event
// stream as the TUI, but only to (a) know whether the server is up, (b) show
// active sessions in the menu, and (c) fire a native notification when a new
// ask/approval arrives. It never sends frames — answering stays in the TUI.
final class ServerConnection: NSObject {
    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private var url: URL
    private var reconnectDelay: TimeInterval = 1
    private var closed = false

    var onConnected: (() -> Void)?
    var onDisconnected: (() -> Void)?
    var onSessions: (([Session]) -> Void)?
    var onNewMessage: ((Message) -> Void)?
    var onPendingMessages: (([Message]) -> Void)?

    private var sessions: [String: Session] = [:]
    private var messages: [String: Message] = [:]

    init(url: URL) {
        self.url = url
        super.init()
        self.session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }

    func updateURL(_ newURL: URL) {
        guard newURL != url else { return }
        url = newURL
        reconnect()
    }

    func connect() {
        closed = false
        openSocket()
    }

    func stop() {
        closed = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func openSocket() {
        guard !closed else { return }
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        receive()
    }

    private func reconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        openSocket()
    }

    private func scheduleReconnect() {
        guard !closed else { return }
        onDisconnected?()
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, 15)
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.openSocket()
        }
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                self.scheduleReconnect()
            case .success(let message):
                self.reconnectDelay = 1
                self.onConnected?()
                switch message {
                case .string(let text):
                    self.handle(Data(text.utf8))
                case .data(let data):
                    self.handle(data)
                @unknown default:
                    break
                }
                self.receive()
            }
        }
    }

    private func handle(_ data: Data) {
        guard let event = ServerEvent.decode(data) else { return }
        switch event {
        case .initial(let messages, let sessions):
            self.sessions = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
            self.messages = Dictionary(uniqueKeysWithValues: messages.map { ($0.id, $0) })
            emitSessions()
            emitPending()
            // Don't post native notifications for the backlog delivered on
            // connect — it still shows in the menu's pending list.
        case .sessionUpdated(let s):
            sessions[s.id] = s
            emitSessions()
        case .messageNew(let m):
            messages[m.id] = m
            emitPending()
            if m.status == .pending && (m.kind == .ask || m.kind == .approval) {
                onNewMessage?(m)
            }
        case .messageAnswered(let id, let answer, let answeredAt):
            if var m = messages[id] {
                m = Message(id: m.id, kind: m.kind, agent: m.agent, project: m.project,
                            body: m.body, context: m.context, suggestion: m.suggestion,
                            status: .answered, answer: answer,
                            createdAt: m.createdAt, answeredAt: answeredAt)
                messages[id] = m
            }
            emitPending()
        }
    }

    private func emitPending() {
        let pending = messages.values
            .filter { $0.status == .pending }
            .sorted { $0.createdAt > $1.createdAt }
        onPendingMessages?(pending)
    }

    private func emitSessions() {
        let active = sessions.values
            .filter { $0.isActive }
            .sorted { $0.startedAt < $1.startedAt }
        onSessions?(active)
    }
}

extension ServerConnection: URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol proto: String?) {
        onConnected?()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                    reason: Data?) {
        scheduleReconnect()
    }
}
