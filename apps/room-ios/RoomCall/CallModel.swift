import Foundation
import LiveKit

@MainActor
final class CallModel: ObservableObject {
    let info: JoinInfo
    let room: Room

    init(info: JoinInfo) {
        self.info = info
        self.room = Room(
            roomOptions: RoomOptions(
                defaultScreenShareCaptureOptions: ScreenShareCaptureOptions(useBroadcastExtension: true)
            )
        )
    }

    var local: LocalParticipant { room.localParticipant }

    func connect() async throws {
        try await room.connect(url: info.url, token: info.token)
        try await local.setMicrophone(enabled: true)
    }

    func disconnect() async {
        await room.disconnect()
    }

    func toggleMic() async {
        try? await local.setMicrophone(enabled: !local.isMicrophoneEnabled())
    }

    func toggleCamera() async {
        try? await local.setCamera(enabled: !local.isCameraEnabled())
    }

    func flipCamera() async {
        guard let track = local.firstCameraVideoTrack as? LocalVideoTrack,
              let capturer = track.capturer as? CameraCapturer else { return }
        _ = try? await capturer.switchCameraPosition()
    }

    func toggleScreenShare() async throws {
        try await local.setScreenShare(enabled: !local.isScreenShareEnabled())
    }
}
