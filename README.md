<p align="center">
  <img src="./assets/images/icon-transparent.png" width="120" alt="Resonuls icon" />
</p>

<h1 align="center">Resonuls</h1>

<p align="center">
  A clean music player for your self-hosted server, your network shares, and
  your local files.
  <br />
  Android, Android Auto and Android TV, with an experimental iOS build.
</p>

<p align="center">
  <em>A fork of <a href="https://github.com/juananzzz/resonus">Resonus</a> by
  <a href="https://github.com/juananzzz">juananzzz</a>, with everything below
  added on top.</em>
</p>

---

<p align="center">
  <a href="https://github.com/HeLLsSs/resonus/releases/latest"><img src="https://img.shields.io/badge/⬇_Download_APK-6366F1?style=for-the-badge" alt="Download APK" /></a>
  <a href="https://apps.obtainium.imranr.dev/redirect?r=obtainium://add/https://github.com/HeLLsSs/resonus"><img src="./assets/images/obtainium.svg" height="28" alt="Get via Obtainium" /></a>
</p>

## Screenshots

| Home | Player | Queue |
| :---: | :---: | :---: |
| <img src="./assets/screenshots/fork-home.jpg" width="200" alt="Home" /> | <img src="./assets/screenshots/fork-player.jpg" width="200" alt="Playing a track from a For you mix" /> | <img src="./assets/screenshots/fork-queue.jpg" width="200" alt="A queue weaving library and YouTube tracks" /> |

| YouTube | Navifind | Settings |
| :---: | :---: | :---: |
| <img src="./assets/screenshots/fork-youtube.jpg" width="200" alt="The YouTube tab" /> | <img src="./assets/screenshots/fork-navifind.jpg" width="200" alt="Navifind settings" /> | <img src="./assets/screenshots/fork-settings.jpg" width="200" alt="Settings, with the outputs this fork adds" /> |

## What this fork adds

Everything Resonus does, plus:

### Navifind and YouTube Music

**What Navifind is.** A small companion server of mine that sits between the
app and Navidrome. Everything it does not recognise it passes straight through,
so to the app it is an ordinary Subsonic server; what it adds is answering a
search with tracks that are not in the library yet, and keeping a YouTube Music
session so the app can show what that account is given. It is a separate
project, it is not published here, and I would rather be asked than post it: if
it is of use to you, get in touch through this repository.

The app works perfectly well without it. Every feature below simply does not
appear when it is switched off.

- **Navifind support**: with the proxy in
  front of Navidrome, a search also answers with tracks it can fetch from
  YouTube and SoundCloud. They are badged as such, play straight away, and the
  proxy files them into the library by itself after ten seconds of listening.
- **Import from a link**: paste a YouTube, SoundCloud or Spotify address and a
  playlist or album becomes a playlist of the same name on the server once its
  tracks have arrived. A notification says when the proxy has finished.
- **A YouTube tab**: the shelves of the YouTube Music home page your account is
  shown, your playlists, the tracks you liked and the records you keep. It
  starts off and is offered only where Navifind is on.
- **Signing in from the phone**: one button opens Google's own sign-in page
  inside the app, and the session it leaves behind goes to the proxy by itself.
  Two-factor, passkeys and account recovery all behave as they do anywhere
  else, and no password passes through the app. Pasting a browser's `Cookie`
  header still works underneath, as the way out.
- **More than one YouTube account**: sign in to each of them and the tab
  carries the one it is reading, with a tap to move to the next. The mix below
  reads whichever is active, so switching here changes what it builds from.

### A mix built from what you listen to

- **"For you"**: one press and it plays music drawn from three places at once —
  what the library answers for the artists and genres you play most, your
  favorites, and what YouTube Music picks for your account. They are woven
  rather than laid end to end, what you heard in the last three hours is left
  out, and a song your server and YouTube both have is taken once.
- It leaves a dated playlist behind. The library's songs go in immediately and
  each YouTube track joins as the proxy finishes fetching it, so the music
  starts at once rather than waiting on the playlist. The toast that announces
  it offers to download that playlist, which is what you want before a drive
  and not something anybody would go looking for in a setting.
- **It knows what time it is.** Artists and genres played at this hour of the
  day count double against those played at any other, so an evening press and a
  morning one no longer build the same thing.
- **What you skip no longer counts as what you like.** A song used to enter the
  history the moment it started, so one skipped after three seconds sat there
  exactly like one heard to the end — and everything built on that history was
  reading a taste out of a rejection. How much of each song was actually heard
  is written down as it plays; under a fifth of the way in counts for nothing.
- A **"For you" shortcut on the app icon**, beside Shuffle, Favorites and
  Resume: a long press and the mix starts without opening the app.

### Listening together

- **A Jam**: several people hearing the same queue at the same moment, each on
  their own device, like Spotify's. Open one from the Output sheet or
  Settings › Navifind, give out the six-letter code, and anybody in it can add
  songs, skip, seek or pause: the change reaches every device at once. The
  proxy keeps the session and is the clock, so nothing is streamed between
  phones and nobody's phone has to stay in front.
- **Guests need no app and no account.** `https://<your proxy>/jam/<code>`
  opens a page in any browser, with a QR code to scan for it, where a guest
  searches the library and the web, adds to the queue and listens along; a
  guest who has the app can open the session in it from there. Every player keeps
  itself within a few tens of milliseconds of the session, correcting quietly
  by playing a touch faster or slower rather than jumping.
- **The host's sound can go anywhere.** In a Jam the phone can play through
  any of its outputs: a Chromecast, a Home Assistant or Music Assistant
  player, a WiiM group. The session still decides what plays and when; the
  phone hands it to the speaker and keeps it within a few seconds.
- **The Jam in the house is a tap away**: the sessions under way on the
  server are listed on the Jam screen and named on the output sheet's row.
- `resonuls://jam/<code>` joins that session from a link, and so does the
  page's own `https://<proxy>/jam/<code>` once the proxy publishes the app's
  signing certificate under `/.well-known/assetlinks.json` (Android app
  links): scanning the QR code then opens the app straight away. The host is
  declared in `app.json` under `android.intentFilters`.

### In a browser

- **The same app on the web.** `scripts/build-web.sh` exports the app for
  the browser and the proxy serves it at `https://<proxy>/app`: sign in with
  your account and the library, the playlists, the YouTube tab, the mixes and
  the Jam are there. What the browser cannot do is left out of it: casting,
  DLNA, LinkPlay, Android Auto, the widget, the equaliser and downloads.
  Playback is the browser's own, and a Jam is the same Jam.
- **What you played stays within reach.** A service worker keeps the app,
  the covers, the answers the library screens are built from and the songs
  that were played, within a budget, so the page opens and the recent songs
  play with no network. A browser has no file system to download into, so
  this is as far as offline goes there.

### More outputs

- **Home Assistant**: the media players it knows, Chromecast, DLNA and Sonos
  among them, appear in the Output sheet. One speaker is often several entities
  there, so they are kept one per name, and the one that can wake a speaker in
  standby is remembered and asked first.
- **WiiM and other LinkPlay speakers**, over the speaker's own API: a WiiM
  Mini has no Chromecast and this is the way to reach it. They are found by
  mDNS, or typed in by address for a network that swallows the announcement,
  and one speaker playing brings the others into its multiroom group from
  the output sheet, one control per speaker, the way Sonos rooms do. The
  speaker only speaks HTTPS with a certificate of LinkPlay's own, which the
  app pins and trusts for nothing else.
- **Music Assistant**, spoken to directly rather than through Home Assistant.
  Nothing is polled, and no address is handed to a speaker: a song is named by
  its id in the library Music Assistant already keeps, and it fetches the song
  itself. So a server behind custom headers casts like any other, and the phone
  does not have to stay awake for the music to go on.

### Android Auto

- **Search reaches the whole library**, not only the browse tree the phone had
  pushed, so a record nobody has played lately is found by typing its name.
  Results come grouped under Songs, Albums and Artists.
- **Keep a song as a favorite from the playback screen**, which until now meant
  picking up the phone.
- **The car says when a song will not play.** A server going out of reach used
  to stop the music and leave the screen saying nothing.
- **The browser explains itself when there is nothing to show** — no account on
  this phone, or offline with nothing downloaded — rather than offering empty
  tabs. A row that resumes a song carries how far through it already is.
- **The car, the widget and another app's broadcast start the app themselves**,
  with no screen and nothing brought to the front. A song tapped on the car's
  screen with the phone asleep in a pocket used to be handed to nobody.
- **A YouTube tab in the car**, the fourth and last Android Auto will draw, and
  it carries the whole home page as the phone does: every shelf the account is
  shown, in its order, each a folder of what it holds, each wearing the cover
  of what it opens. Nothing is fetched to draw it — the tracks arrive with the
  page — which is what lets twenty shelves and a hundred and thirty tiles cost
  the one request that drew them.
- **The queue screen says where the queue came from** — the album, the
  playlist, "For you" — rather than heading a list of songs with nothing.
- Pictures reach the car at all. It will not go and fetch one from a remote
  address, whatever the address, so a YouTube thumbnail handed over as a link
  showed nothing; the phone fetches them and hands over the files.

### On a television

- **Resonuls installs on Android TV.** It declares that it works without a
  touchscreen, carries the leanback launcher category so a TV lists it, and has
  a banner for the home row. Sideload the APK and it is there beside everything
  else.
- **The remote's focus is drawn**: a green ring around whatever would answer if
  you pressed OK. Android tracks the focus already and simply never draws it —
  a view is only highlighted by its own background, and React Native's views
  have none — so without this the app is perfectly navigable and completely
  invisible. The ring is drawn once, over the whole app, and appears on
  televisions only.
- **It is laid out for a television, not shown on one.** Everything the app
  measures itself with — the type, the gaps, the corners, the icons, the tab
  bar, the mini player — is scaled up when it starts on a TV: a set reports 960
  points across where a phone reports 400, so the line that fills a phone
  crosses a sixth of a television. An album lays its cover beside its title
  rather than above it, which is what puts the songs on screen instead of below
  the fold.
- **What a television does differently is handled**, not left to fail. Android
  TV ships no file picker, so "choose a folder" used to land on a stub and the
  press looked broken; the option that works is offered first there. The
  warning about battery optimisation never appears, a set being plugged into a
  wall.

### Your music from more than one place

- **Network shares.** A WebDAV share — Nextcloud, ownCloud, a NAS — is added
  under Settings › Network shares and browsed as folders: open one, press a
  song, and the folder plays as a queue from there. Nothing is scanned and
  nothing is copied, which is the bargain: a share of ten thousand files works
  the moment it is added rather than after an evening of reading tags over a
  network. Seeking works, because the servers serve a byte range. The password
  goes to the phone's secure store and never into an address — what opens the
  file rides in a header, so the address that reaches the media session carries
  nothing.
- **The clouds that speak WebDAV can be picked by name**: pCloud, Koofr,
  Yandex Disk, Mail.ru, Box, Fastmail, kDrive and Nextcloud. Choosing one fills
  in the address, which is the part nobody knows by heart and every service
  hides in a help page under a different name. Google Drive, Dropbox and
  OneDrive are not among them: none of the three speaks WebDAV, and each needs
  a key registered with it in the name of the app.
- **A share's songs fill in their own names.** The tags are read behind the
  list, a few hundred bytes per file rather than the file, so a folder is
  usable at once and the titles, artists and albums appear as they arrive.
  MP3, FLAC and M4A are all read — a share is usually where the lossless files
  live, and those used to come back as a list of filenames. Anything else keeps
  its filename.
- **Searching can ask every server you are signed in to**, not only the active
  one (Settings › Library). Results are laid out this server's first, then each
  of the others under its name, and what comes from elsewhere plays, opens,
  downloads and can be starred on the server it came from. A server that is
  asleep is skipped rather than turning the whole search into an error. Off by
  default, and the switch only appears once there is a second server.

### A song you listened through is kept

- The next time it plays from the phone: no wait, no data, and it survives a
  tunnel. It has its own space and never touches what you downloaded on purpose
  — a download is a promise somebody made to themselves, and nothing here may
  delete one.
- It fills while you listen, empties from the oldest listen when it is full,
  and only ever over Wi-Fi: the point is to spend less data, not to spend it
  twice. How much it may hold is yours to set, from one gigabyte to twenty,
  under Settings › Downloads and offline — where it can also be emptied.
- What it keeps is exactly what the player would have streamed, quality setting
  and headers included, so a server behind an authenticating proxy is cached
  too.

### Sound

- **A real equaliser.** Ten bands at the octave centres every graphic equaliser
  has used for forty years, filtered inside the player rather than handed to
  the device — Android gives you the bands it feels like offering, which is
  five on most phones at frequencies nobody chose. These ten are the same ten
  on the phone, in the car and on the television, so a setting means the same
  thing wherever you took it.
- **A preamp**, because raising a band makes the music louder and a track
  mastered near the top will clip. Eight presets, the app's own.
- **Float output** is asked for, so where the device takes thirty-two-bit
  floats the samples reach it as the filters left them rather than being
  squeezed back into sixteen bits on the way out.

### Lists

- **More ways to sort a song list**: the date added, the year, the length, the
  play count and the rating, either way round. A song the server says nothing
  about goes to the end whichever way the list runs.
- **A quick filter** narrows a list to the downloaded songs or the favorites
  for as long as you are looking at it, with a line across the top saying how
  much it is hiding.
- Both reach albums, playlists, smart playlists, an artist's songs, the
  favorites and the bookmarks.

### Elsewhere

- Custom HTTP headers reach casting, DLNA and the car: a server behind them is
  relayed through the phone rather than handed out as an address.
- The update check looks at this fork's own releases.
- French translation.

## Download

Get the latest APK from the [Releases](https://github.com/HeLLsSs/resonus/releases/latest)
page, or add the repository to
[Obtainium](https://apps.obtainium.imranr.dev/redirect?r=obtainium://add/https://github.com/HeLLsSs/resonus)
for automatic updates. The app also checks for a newer release by itself and
can download and install it; the switch is under Settings › About.

**On a television**, the APK has to be sideloaded: the simplest way is the
Downloader app from your TV's own store, pointed at the releases page above.

## Features

Everything the upstream project does:

- **Navidrome / OpenSubsonic / Jellyfin / Ampache**: multi-profile login, multi-library support, plus several server addresses with automatic switching
- **Local mode**: play music straight from your device or a folder, no server needed
- **Offline mode**: your favorites, playlists and albums stay browsable with no connection; downloaded songs play, the rest show grayed out, and it switches automatically when the server is unreachable
- **Downloads**: albums, playlists, an artist's whole discography or single songs, in original quality or transcoded
- **Synced lyrics**: karaoke view with tap-to-seek, full-screen mode, optional LRCLIB lookup
- **Internet radio**: browse and manage your stations
- **Cast to speakers**: UPnP/DLNA renderers and Sonos, with room grouping; local music streams to them too
- **Playback**: gapless, crossfade, built-in equalizer, ReplayGain normalization, playback speed, sleep timer, queue with undo, shuffle, repeat, background & lock-screen controls
- **Autoplay & mixes**: keep the music going with similar songs, or start a mix from any track
- **Organize**: multi-select (queue, playlist or download in batch), star ratings, pinned items, play history
- **Themes**: dark, light (experimental) or whichever one the phone is on, each with its own accent color
- **Make it yours**: reorder and show/hide Home sections and explore chips, app fonts, configurable swipe and ⋯ menu actions
- **Landscape and tablet layouts**
- **Queue sync across devices**
- **In 9 languages**: English, Spanish, German, Catalan, Russian, Italian, Simplified Chinese, Ukrainian, French

## FAQ

The questions that come up most often are answered in
[docs/FAQ.md](./docs/FAQ.md), starting with how to get the app to show up in
Android Auto. Controlling it from other apps is documented in
[docs/INTENTS.md](./docs/INTENTS.md).

## Credits

Resonuls is a fork of [Resonus](https://github.com/juananzzz/resonus), which is
where almost all of this comes from. If you enjoy the app, the person to thank
is [juananzzz](https://github.com/juananzzz) — there is a
[Ko-fi](https://ko-fi.com/juananzzz) and a
[Discord](https://discord.gg/pecE8MTPVr) for the upstream project.

Thanks to the people who have translated the app:

| Language | Contributor(s) |
| --- | --- |
| English | [juananzzz](https://github.com/juananzzz) |
| Español | [juananzzz](https://github.com/juananzzz) |
| Deutsch | [Psychotoxical](https://github.com/Psychotoxical), [CraftoHohenvels](https://github.com/CraftoHohenvels) |
| Català | [juananzzz](https://github.com/juananzzz) |
| Русский | [ztx-lyghters](https://github.com/ztx-lyghters) |
| Italiano | [Anakin-bb8](https://github.com/Anakin-bb8) |
| 简体中文 | [xcdmrCHP](https://github.com/xcdmrCHP) |
| Українська | [albedych](https://github.com/albedych) |
| Français | [HeLLsSs](https://github.com/HeLLsSs) |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to set up the project, run it
on an emulator, and open a pull request. Changes that are not specific to this
fork are worth sending upstream.
