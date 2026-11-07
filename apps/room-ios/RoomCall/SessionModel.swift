import Foundation

@MainActor
final class SessionModel: ObservableObject {
    @Published var invite: Invite?
    @Published var call: CallModel?
    @Published var busy = false
    @Published var error: String?

    init() {
        if let saved = Keychain.load() { invite = Invite(link: saved) }
    }

    func signIn(link: String) {
        guard let parsed = Invite(link: link) else {
            error = "That doesn't look like a Room invite link."
            return
        }
        Keychain.save(parsed.link)
        invite = parsed
        error = nil
    }

    func signOut() {
        Keychain.delete()
        invite = nil
        error = nil
    }

    func join() async {
        guard let invite, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let info = try await TokenClient.fetch(invite)
            let model = CallModel(info: info)
            try await model.connect()
            call = model
        } catch {
            self.error = error.localizedDescription
        }
    }

    func leave() {
        let model = call
        call = nil
        Task { await model?.disconnect() }
    }
}
