import SwiftUI

@main
struct RoomCallApp: App {
    @StateObject private var session = SessionModel()

    var body: some Scene {
        WindowGroup {
            Group {
                if let call = session.call {
                    CallView(call: call, onLeave: { session.leave() })
                } else {
                    SignInView(session: session)
                }
            }
            .preferredColorScheme(.dark)
        }
    }
}
