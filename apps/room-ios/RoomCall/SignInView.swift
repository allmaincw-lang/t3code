import SwiftUI

struct SignInView: View {
    @ObservedObject var session: SessionModel
    @State private var link = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Spacer()
            Text("Room").font(.largeTitle.bold())

            if let invite = session.invite {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Signed in to").font(.caption).foregroundStyle(.secondary)
                    Text(invite.base.host ?? invite.base.absoluteString).font(.headline)
                }
                Button {
                    Task { await session.join() }
                } label: {
                    HStack {
                        if session.busy { ProgressView() }
                        Text(session.busy ? "Joining…" : "Join call").frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(session.busy)

                Button("Use a different invite", role: .destructive) { session.signOut() }
                    .disabled(session.busy)
            } else {
                Text("Paste the invite link you use to open the Room.")
                    .foregroundStyle(.secondary)
                TextField("https://…#invite=…", text: $link, axis: .vertical)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .lineLimit(1...4)
                    .padding(12)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityIdentifier("inviteField")
                Button {
                    session.signIn(link: link)
                } label: {
                    Text("Sign in").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty)
            }

            if let error = session.error {
                Text(error).font(.callout).foregroundStyle(.red)
            }
            Spacer()
        }
        .padding(24)
    }
}
