# Sathya Staff app (Android and iPhone)

The staff app is the same HMS web app, opened on a phone. Everyone signs in with their email and password (the MD or GM adds logins under **Staff → Logins**), then taps **Staff**.

| Screen | Who | What |
|---|---|---|
| Today | everyone | language (English / தமிழ்), the location policy (accepted once), clock in and out, the shift and late minutes, **SOS**, and their work: rooms to clean, food ready to pick up, open SOS alerts for security |
| Messages | everyone | messages from managers, by role; urgent ones are marked |
| My attendance | everyone | their own days and hours, and where the app placed them today |
| Team | managers, security | SOS alerts (I'm going / resolve), who is on duty and where, who is rostered but not in, today's attendance with selfies |
| Rosters | HR, managers | shifts (morning, evening, night…) and the weekly roster; copy last week |
| Settings | GM, MD | the resort boundary, lining up GPS with the 3D map, selfie at clock-in, indoor beacons |

## Location and privacy

- Location is recorded **only between clock-in and clock-out**. The phone shows “📍 Location on: on duty” at the bottom of every screen while it is shared.
- Before the first clock-in each person reads and accepts the location policy, in English or Tamil. Acceptance is stored with the date.
- Clock-in is refused more than the boundary radius (plus the phone's GPS accuracy, up to 100 m) from the resort centre.
- On duty, more than 15 minutes outside the boundary tells the operations manager once (the audit log records it).
- Positions are kept for 90 days, then deleted. Each person can see their own history; only managers and security can see the team.
- Clock-in selfies can be seen only by the person and by those who check attendance.

## Setting up the boundary and the map

1. Sign in as the GM or MD on a phone, and stand at the middle of the resort.
2. Open **Staff → Settings** and press **Use my location**. Set the radius to cover the whole property (start with 400 m), then Save.
3. Lining up with the 3D map: **Map x / z** is where that centre point is on the model, in metres east and south of the model's origin. Read it in Twin Studio by hovering the same spot. **Rotation** is how far the model is turned from true north.
4. Walk to two far corners with someone watching the Staff layer on the 3D map, and adjust the rotation until the pin is where the person is standing.

GPS is poor inside buildings. There are two ways to place someone indoors:

- **Bluetooth beacons**: add one per area in Settings, with the id the phone reads. This needs the packaged app.
- **QR labels**: the labels already printed for public areas and rooms also place the person when scanned.

## The 3D map

Managers and security get a **Staff on duty** layer. It shows:

- One pin per person, coloured by role:
  - blue: security
  - teal: housekeeping
  - gold: food & beverage
  - orange: engineering
  - purple: managers
  - green: reception
- A faded pin when the person has not been seen for 10 minutes.
- A pulsing red ring for an open SOS.

The pins refresh every 15 seconds, and at once on an SOS. An SOS also pops up for everyone with the Staff layer.

## Packaging for the stores (background location)

In a phone browser, location is shared while the app is open. Sharing it with the screen off needs the packaged app. That is the web app inside a Capacitor shell with the community background-geolocation plugin; `src/staff/tracker.ts` switches to the plugin automatically when it is present.

```
npm i -D @capacitor/cli
npm i @capacitor/core @capacitor/android @capacitor/ios @capacitor-community/background-geolocation
# set server.url in capacitor.config.json to the HMS address (https)
npx cap add android
npx cap add ios
npx cap sync
npx cap open android          # build and sign in Android Studio
npx cap open ios              # build and sign in Xcode (needs a Mac and an Apple developer account)
```

Each platform needs its location permissions declared before the store build.

**Android** (`android/app/src/main/AndroidManifest.xml`):
- `ACCESS_FINE_LOCATION`
- `ACCESS_BACKGROUND_LOCATION`
- `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_LOCATION`
- `POST_NOTIFICATIONS`

**iOS** (`ios/App/App/Info.plist`):
- `NSLocationWhenInUseUsageDescription`
- `NSLocationAlwaysAndWhenInUseUsageDescription`
- `UIBackgroundModes` set to `location`

Use the policy text from the Today screen as the reason the phone shows.

The Play Store and App Store both review background location. Give them the stated purpose (staff safety and task routing on duty, nothing shared off duty) and a demo account.

Staff phones can instead be enrolled with an MDM, or the APK can be shared directly to resort-owned phones. That avoids the store listing.
