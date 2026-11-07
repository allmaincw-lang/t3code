# Room (iOS)

Minimal SwiftUI app for joining Room calls from an iPhone, with whole-phone
screen sharing (iPhone Safari cannot share the screen). It signs in with your
Room invite link, calls `POST <room>/api/livekit/token` (invite as
`Authorization: Bearer`, returns `{ url, token, room }`), and joins with
LiveKit's Swift SDK.

- `RoomCall/` – the app: invite sign-in (Keychain), call grid, mic, camera, flip camera, screen share, leave.
- `BroadcastExtension/` – ReplayKit Broadcast Upload Extension (`LKSampleHandler`) that delivers screen frames to the app through an app group.
- `Config.xcconfig` – the one place to set your bundle id.

## What is verified

Verified on a Mac with Xcode 15.2: the project resolves packages, builds for the
iOS Simulator (app plus embedded broadcast extension), and the app launches to
the sign-in screen.

Not verified, needs a real iPhone: camera, microphone, joining a live call,
and screen sharing (the Broadcast Upload Extension does not run in the
Simulator). The token endpoint was not exercised either.

## LiveKit version and Xcode

The SDK is pinned to **2.4.0** (`RoomCall.xcodeproj` → Package Dependencies,
"Exact Version"). Newer LiveKit releases need a newer Swift toolchain than
Xcode 15.2 (2.5.0–2.7.x call iOS 17 APIs, 2.7.2+ generated code needs Swift
5.10, 2.14+ needs Swift 6). 2.4.0 is the newest that compiles on Xcode 15.2.

**Your iPhone runs iOS 18.7, and Xcode 15.2 cannot install to it** (device
support for iOS 18 arrived in Xcode 16). To put the app on the phone, install
Xcode 16.3 or newer, then in Xcode choose the LiveKit package, set it to
"Exact Version" `2.19.0` (or another release that builds), and build. The
Swift sources use APIs that exist in both.

## Install on your iPhone (free personal team)

1. Install Xcode 16.3+ from the App Store, open it once and accept the license.
2. Xcode → Settings → Accounts → add your Apple ID (this creates a free "Personal Team").
3. Edit `Config.xcconfig` and set `ROOM_APP_BUNDLE_ID` to something unique to you, for example `com.yourname.room`. The extension becomes `<id>.broadcast` and the app group `group.<id>`.
4. Open `apps/room-ios/RoomCall.xcodeproj`. Wait for packages to resolve.
5. Select the **RoomCall** target → Signing & Capabilities → Team: your Personal Team. Do the same for the **BroadcastExtension** target. Both must use the same team. Xcode registers the App Groups capability for both automatically.
6. Connect the iPhone by cable, unlock it, tap Trust. On iOS 16+ enable Settings → Privacy & Security → Developer Mode and restart.
7. Pick your iPhone as the run destination and press Run.
8. On the phone: Settings → General → VPN & Device Management → your Apple ID → Trust.
9. Open Room, paste your invite link (the `https://…/#invite=…` one), tap Sign in, then Join call. Allow camera and microphone.
10. Share: tap Share, choose **Room Broadcast** in the system sheet, tap Start Broadcast. Stop from the red status pill or Control Center.

Limits of a free personal team:

- The app stops launching after **7 days**. Re-run from Xcode to re-sign it (data in the Keychain survives a re-install over the top).
- Max 3 apps per device, and a limited number of new App IDs per week. The app plus extension use two App IDs.
- The broadcast extension must be signed by the **same team** as the app and share the same app group, otherwise the "Start Broadcast" sheet does nothing or the share never arrives.
- If Xcode says the bundle id or app group is unavailable, choose a different `ROOM_APP_BUNDLE_ID`.
- No TestFlight or App Store distribution without a paid account.

## Build for the Simulator

```bash
cd apps/room-ios
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild build \
  -project RoomCall.xcodeproj -scheme RoomCall \
  -destination 'platform=iOS Simulator,name=iPhone 15' \
  -derivedDataPath build/dd CODE_SIGNING_ALLOWED=NO
```

Screen sharing and real media do not work in the Simulator; use it to check the UI.
