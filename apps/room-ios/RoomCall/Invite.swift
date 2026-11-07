import Foundation

/// A Room invite link such as `https://room.example.com/#invite=abc` or
/// `https://room.example.com/?invite=abc`. The server base is the link's
/// origin plus any path prefix the Room is served behind.
struct Invite: Codable, Equatable {
    let base: URL
    let secret: String

    var link: String { "\(base.absoluteString)#invite=\(secret)" }

    init?(link raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var comps = URLComponents(string: text),
              let scheme = comps.scheme, scheme == "https" || scheme == "http",
              comps.host != nil else { return nil }

        let keys = ["invite", "token", "t"]
        func value(in query: String?) -> String? {
            guard let query else { return nil }
            var probe = URLComponents()
            probe.query = query
            return probe.queryItems?.first { keys.contains($0.name) && !($0.value ?? "").isEmpty }?.value
        }
        guard let secret = value(in: comps.fragment) ?? value(in: comps.query) else { return nil }

        comps.query = nil
        comps.fragment = nil
        var path = comps.path
        while path.hasSuffix("/") { path.removeLast() }
        if path.hasSuffix("/join") { path.removeLast(5) }
        comps.path = path
        guard let base = comps.url else { return nil }
        self.base = base
        self.secret = secret
    }
}
