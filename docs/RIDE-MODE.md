# Ride mode (Android)

Resonus on a motorbike: a screen of buttons a glove can hit, a floating
player over Waze or any other app, each new song read out in the helmet, and
all of it started on its own when the helmet's intercom connects. Android
only.

## What it does

Ride mode on means:

- **The ride screen.** Black and white for sunlight, four big buttons (play or
  pause, previous, next, volume) and the cover; the screen stays on. A flick
  left or right across it skips too. The cross in the corner turns ride mode
  off and closes the screen.
- **Navigation prompts dip the music instead of pausing it.** Everywhere else
  the app asks for exclusive audio, which is what ties the lock screen
  controls to it, and a prompt from Waze pauses the song and resumes it after.
  On a bike the prompts come every minute, so while ride mode is on the song
  goes on at half volume under them.
- **The floating player** (optional): a pill with the title and three buttons,
  over whatever app is in front, in two sizes (the large one for thick
  gloves). Drag it by the title; tap the title to come back to the ride
  screen. It needs the permission to draw over other apps, asked on the
  system's own screen when the switch is turned on.
- **Songs announced** (optional): each new song is read out through the
  phone's text-to-speech engine, in the phone's language, with the same audio
  usage as a navigation app's prompts so it goes where they go and the music
  dips under it.
- **Voice, Shuffle and Radio.** Wide buttons under the volume. Voice brings
  up the phone's own speech dialog (Google's, on most phones; the app records
  nothing itself): say a song or an artist and the songs found play, or one
  of "next", "pause", "previous", "favourites", "shuffle", "radio", in
  French or English. Shuffle is the same die as the Home tab's: the library
  dealt, and YouTube's picks with it when the proxy has an account. Radio
  plays the station chosen as **Radio station** in the settings, and the
  button is only there when one is.
- **The battery read out** in the helmet at 20, 10 and 5 %, while not
  charging, when announcements are on.
- **Prepare the ride.** A wide button under the rest downloads the next
  songs of the queue (the one playing and the ones after it, round to the
  start when the queue repeats) so the bike can leave 4G and the holes in
  it behind. How many is **Songs to prepare** in the settings: 15, 30, 60 or
  the whole queue. What is already on the phone is skipped and does not
  count; a track the proxy found online is fetched like any other. On mobile
  data it asks first, unless downloads are Wi-Fi only, in which case the
  download refuses by itself. The count comes up on the button as the songs
  arrive, and a toast says how many made it.
- **Prepare on its own** (optional, off by default): the same download
  without a tap, see below.
- **Volume with the speed** (optional, off by default): the media volume
  rises over the rider's own level as the bike goes faster, see below.
- **The music back after a call.** The phone gives the audio back on its
  own when a call ends and the player follows; when it has not within a
  few seconds, ride mode starts it again.
- **The app over the lock screen.** A phone locked in a pocket shows the ride
  screen without being unlocked, and every screen of the app is reachable
  that way while ride mode is on. It stops with it.
- **Full brightness, then nearly none.** The ride screen goes to full
  brightness for the sun, and after a minute untouched drops to almost
  nothing, since hours at full brightness on a handlebar is heat and a
  drained battery. The first tap only wakes it.

## Preparing the ride on its own

With **Prepare on its own** on (Settings › Ride mode, under Prepare the
ride), the queue is prepared the way the button does it, with the same
count, when the phone is on its charger and on Wi-Fi, and either it is
night (22:00 to 06:00, the phone's time) or the screen has been off for ten
minutes. Once in twelve hours at most; nothing is fetched when the next
songs are already on the phone. It is quiet about it: the toast at the end
only shows on a lit screen. The decision is `shouldAutoPrepare` in
`src/lib/rideMode.ts`.

What it does not do: there is no job scheduled with Android. The check runs
in the app's JavaScript whenever one of the conditions changes (the battery
reported by the ride module, which watches it for as long as the app runs,
ride mode on or not; the network; the screen going on or off; the app
coming to the front or leaving it), so it only happens while the app's
process is alive. A music player's process usually is, and on the charger
the phone does not doze, but a phone that has killed the app, or a reboot
with the app never opened, prepares nothing until the app is started again.

## Volume with the speed

With **Volume with the speed** on, while ride mode is on, the ride module
reads the speed off the phone's GPS (a fix every two seconds) and the media
volume goes up over the rider's own level against the wind: nothing below
30 km/h, then evenly up to one, two or three volume steps at 110 km/h, for
**Raised by** light, medium or strong. The speed is smoothed over the last
few readings and the volume moves one step at a time, only once the speed is
well past a threshold, so a speed hovering around one does not pump it up
and down; it never goes past the maximum. The rider keeps the say: a press
of the volume keys or of the ride screen's buttons becomes the new level,
and the speed adds to it from there instead of pulling it back. When ride
mode stops, the GPS is let go and the volume goes back to the rider's own
level. The curve and the smoothing are `speedOffset`, `smoothSpeed` and
`nextSpeedSteps` in `src/lib/rideMode.ts`; applying them is `syncSpeed` in
`src/lib/rideSync.ts`.

The GPS needs the precise location, asked when the switch is turned on (the
switch stays off without it), and then the location "all the time": on a
ride the navigation app is in front, and from Android 10 an app behind
another one gets no position without that second answer, which from
Android 11 is given on the system's own screen. Without it the volume only
follows the speed while the ride screen is in front.

## Starting it from the intercom

Settings › Ride mode › **Start when this device connects** lists the
Bluetooth devices paired with the phone; pick the intercom. From then on,
ride mode starts on its own when that device connects, app running or not,
and stops when it disconnects. A drop of a few seconds does not count: the
intercom is given fifteen seconds to come back before ride mode stops.

Started by the intercom, ride mode sets the media volume to **Volume at the
start** when one is set, says "Ride mode" in the helmet (when announcements
are on) followed by the **Status at the start** (on by default): the battery,
where the music goes when it is not the phone, and how many songs are left in
the queue, in one sentence in the app's language. Saying "status" (or
"statut", "batterie") into the Voice button reads it out again. Then it
brings the ride screen up over whatever is in front,
then the **Navigation app** chosen in the settings (Waze, Google Maps,
Calimoto, Kurviger, OsmAnd, Sygic, HERE or TomTom, whichever the phone has)
over that, with the floating player on top. With **Resume playback** on it
starts the queue again where it was, and **With an empty queue** says what to
start when there is nothing to resume: nothing, the "For you" mix, the
favourites shuffled, or the whole library shuffled.

The same start and stop are the `ride_on` and `ride_off` commands of the
intents API (docs/INTENTS.md), for a tag on the bike or a Tasker profile.

Two permissions, each asked where it is first needed (and the location for
the volume with the speed, above):

- **Bluetooth** (Android 12 and later): to know which device connected. Asked
  when the list of paired devices is first opened.
- **Draw over other apps**: for the floating player, and it is also what lets
  the app come up on its own over the navigation app. From Android 10 the
  system refuses that to an app with nothing on screen unless it holds this
  permission, so it is asked as soon as an intercom is chosen. Without it the
  connection still starts ride mode (the music, the announcements), but the
  screen only comes up when the app is opened by hand.

Ride mode can also be opened by hand: Settings › Ride mode › **Open ride
mode**, the **Ride mode** launcher shortcut (long press on the app icon), or
the link `resonuls://ride`. The **Ride mode** tile of the quick settings
shade (edit the shade to add it) starts and stops it the way the intercom
does, from anywhere.

## Google Assistant

"Hey Google, play X on Resonus" is Google's call, not the app's: on the
phone the Assistant only drives the media apps it knows, and a client of
your own server is not among them. In Android Auto it works, since the car
sends the words to the app's own search. The Voice button is what works
everywhere: the phone's speech dialog turns the words into text and the
app does the rest.

## Why Waze does not list Resonus

Waze's built-in audio player only works with partner apps (Spotify, YouTube
Music, Deezer, TuneIn and a few others), through a closed programme with no
public way in. No Subsonic client can appear there, which is what the
floating player is for.

## How it is built

The native half is `modules/ride-mode`: a manifest receiver for the Bluetooth
connection broadcasts, which reads the chosen intercom from its own
preferences so it works with no JavaScript running and starts the runtime
when it has to; the overlay window; the text-to-speech engine; the battery,
the screen going on and off, and the GPS speed, sent up as events. The JS half
is `src/lib/rideSync.ts`, started from `bootstrap` like the widget and the
car, with the configuration in `src/store/rideMode.ts` and the screens in
`src/app/ride.tsx` and `src/app/settings/ride.tsx`.
