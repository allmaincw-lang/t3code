import Foundation

struct JoinInfo: Decodable {
    let url: String
    let token: String
    let room: String
}

enum TokenError: LocalizedError {
    case rejected
    case server(Int)
    case malformed

    var errorDescription: String? {
        switch self {
        case .rejected: return "The Room rejected this invite. Paste a fresh invite link."
        case .server(let code): return "The Room server returned HTTP \(code)."
        case .malformed: return "The Room server sent an unexpected response."
        }
    }
}

enum TokenClient {
    static func fetch(_ invite: Invite) async throws -> JoinInfo {
        let base = invite.base.absoluteString
        guard let url = URL(string: base + "/api/livekit/token") else { throw TokenError.malformed }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("Bearer \(invite.secret)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw TokenError.malformed }
        if http.statusCode == 401 || http.statusCode == 403 { throw TokenError.rejected }
        guard (200..<300).contains(http.statusCode) else { throw TokenError.server(http.statusCode) }
        guard let info = try? JSONDecoder().decode(JoinInfo.self, from: data) else { throw TokenError.malformed }
        return info
    }
}
