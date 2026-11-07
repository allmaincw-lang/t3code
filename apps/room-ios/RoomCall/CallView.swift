import SwiftUI
import LiveKit

struct CallView: View {
    @ObservedObject var call: CallModel
    let onLeave: () -> Void
    @State private var shareError: String?

    var body: some View {
        RoomScope(room: call.room) {
            CallBody(call: call, onLeave: onLeave, shareError: $shareError)
        }
    }
}

private struct RoomScope<Content: View>: View {
    @ObservedObject var room: Room
    @ViewBuilder var content: () -> Content
    var body: some View { content() }
}

private struct CallBody: View {
    @ObservedObject var call: CallModel
    let onLeave: () -> Void
    @Binding var shareError: String?

    private var participants: [Participant] {
        var all: [Participant] = [call.room.localParticipant]
        all.append(contentsOf: call.room.remoteParticipants.values.sorted { ($0.identity?.stringValue ?? "") < ($1.identity?.stringValue ?? "") })
        return all
    }

    var body: some View {
        VStack(spacing: 0) {
            Text(call.info.room).font(.headline).padding(.vertical, 8)

            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 8)], spacing: 8) {
                    ForEach(participants, id: \.sid) { p in
                        ParticipantTile(participant: p)
                    }
                }
                .padding(8)
            }

            if let shareError {
                Text(shareError).font(.caption).foregroundStyle(.red).padding(.horizontal)
            }
            controls
        }
    }

    private var controls: some View {
        let lp = call.local
        return HStack(spacing: 14) {
            ControlButton(icon: lp.isMicrophoneEnabled() ? "mic.fill" : "mic.slash.fill",
                          label: "Mute", active: lp.isMicrophoneEnabled()) {
                Task { await call.toggleMic() }
            }
            ControlButton(icon: lp.isCameraEnabled() ? "video.fill" : "video.slash.fill",
                          label: "Camera", active: lp.isCameraEnabled()) {
                Task { await call.toggleCamera() }
            }
            ControlButton(icon: "camera.rotate.fill", label: "Flip", active: true) {
                Task { await call.flipCamera() }
            }
            ControlButton(icon: "rectangle.on.rectangle", label: "Share",
                          active: !lp.isScreenShareEnabled(), highlight: lp.isScreenShareEnabled()) {
                Task {
                    do { try await call.toggleScreenShare(); shareError = nil }
                    catch { shareError = "Screen share: \(error.localizedDescription)" }
                }
            }
            ControlButton(icon: "phone.down.fill", label: "Leave", active: false, destructive: true, action: onLeave)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
    }
}

private struct ParticipantTile: View {
    @ObservedObject var participant: Participant

    private var videoTrack: VideoTrack? {
        (participant.firstScreenShareVideoTrack ?? participant.firstCameraVideoTrack)
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Color(white: 0.14)
            if let track = videoTrack, !track.isMuted {
                SwiftUIVideoView(track, layoutMode: participant.isScreenShareEnabled() ? .fit : .fill)
            } else {
                Image(systemName: "person.fill").font(.largeTitle).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            HStack(spacing: 4) {
                if !participant.isMicrophoneEnabled() {
                    Image(systemName: "mic.slash.fill").font(.caption2)
                }
                Text(participant.name ?? participant.identity?.stringValue ?? "Guest").font(.caption).lineLimit(1)
            }
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(.black.opacity(0.55), in: Capsule())
            .padding(6)
        }
        .aspectRatio(3.0 / 4.0, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

private struct ControlButton: View {
    let icon: String
    let label: String
    var active: Bool
    var highlight = false
    var destructive = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: icon).font(.title3).frame(width: 52, height: 52)
                    .background(background, in: Circle())
                Text(label).font(.caption2)
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white)
        .accessibilityLabel(label)
    }

    private var background: Color {
        if destructive { return .red }
        if highlight { return .blue }
        return active ? Color(white: 0.25) : Color(white: 0.45)
    }
}
