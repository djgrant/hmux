import Foundation

// Mirror of @humans/protocol. Kept deliberately small — the app only needs to
// read presence + inbound messages off the WebSocket, never to answer them.

let defaultPort = 7373
let wsPath = "/ws"
let mcpPath = "/mcp"

enum MessageKind: String, Codable {
    case ask, notify, approval
}

enum MessageStatus: String, Codable {
    case pending, answered
}

struct Message: Codable, Identifiable, Equatable {
    let id: String
    let kind: MessageKind
    let agent: String
    var project: String?
    let body: String
    var context: String?
    var suggestion: String?
    let status: MessageStatus
    var answer: String?
    let createdAt: Double
    var answeredAt: Double?
}

enum SessionStatus: String, Codable {
    case working
    case idle
    case needsAttention = "needs-attention"

    var label: String {
        switch self {
        case .working: return "working"
        case .idle: return "idle"
        case .needsAttention: return "needs you"
        }
    }
}

struct Session: Codable, Identifiable, Equatable {
    let id: String
    let agent: String
    var project: String?
    var model: String?
    var status: SessionStatus
    var detail: String?
    let bound: Bool
    let startedAt: Double
    var lastSeen: Double
    var endedAt: Double?

    var isActive: Bool { endedAt == nil }
}

// ServerEvent frames. Decoded via the `type` discriminator.
enum ServerEvent {
    case initial(messages: [Message], sessions: [Session])
    case messageNew(Message)
    case messageAnswered(id: String, answer: String, answeredAt: Double)
    case sessionUpdated(Session)

    static func decode(_ data: Data) -> ServerEvent? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return nil }
        let decoder = JSONDecoder()
        switch type {
        case "init":
            let messages = decodeArray(obj["messages"], Message.self, decoder)
            let sessions = decodeArray(obj["sessions"], Session.self, decoder)
            return .initial(messages: messages, sessions: sessions)
        case "message.new":
            guard let m = decodeField(obj["message"], Message.self, decoder) else { return nil }
            return .messageNew(m)
        case "message.answered":
            guard let id = obj["id"] as? String,
                  let answer = obj["answer"] as? String,
                  let at = obj["answeredAt"] as? Double else { return nil }
            return .messageAnswered(id: id, answer: answer, answeredAt: at)
        case "session.updated":
            guard let s = decodeField(obj["session"], Session.self, decoder) else { return nil }
            return .sessionUpdated(s)
        default:
            return nil
        }
    }
}

private func decodeField<T: Decodable>(_ value: Any?, _ type: T.Type, _ decoder: JSONDecoder) -> T? {
    guard let value, let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
    return try? decoder.decode(T.self, from: data)
}

private func decodeArray<T: Decodable>(_ value: Any?, _ type: T.Type, _ decoder: JSONDecoder) -> [T] {
    guard let arr = value as? [Any] else { return [] }
    return arr.compactMap { decodeField($0, T.self, decoder) }
}
