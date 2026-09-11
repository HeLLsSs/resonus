# Controlling Resonus from other apps (Android)

Resonus can be driven by broadcast intents, so Tasker, Automate, MacroDroid,
an NFC app or `adb shell` can play, pause, skip, start an album or set a sleep
timer without touching the screen. It also broadcasts what it is playing, so
the same tools can react to it. Android only.

## Commands

Send a broadcast with the action `com.hellsss.resonuls.COMMAND` and a string
extra `command`. Extras that carry a value are listed with each command; a
number or a boolean is accepted either as its own type (`--ei`, `--ef`, `--ez`)
or as text (`--es position 90`, `--es on true`).

| `command`       | Extras                                            | Does                                                      |
| --------------- | ------------------------------------------------- | --------------------------------------------------------- |
| `play`          |                                                   | Resumes; nothing happens if already playing.              |
| `pause`         |                                                   | Pauses; nothing happens if already paused.                |
| `toggle`        |                                                   | Play/pause.                                               |
| `stop`          |                                                   | Stops and clears the queue (the long press on play).      |
| `next`          |                                                   | Next track.                                               |
| `previous`      |                                                   | Previous track.                                           |
| `seek`          | `position` seconds                                | Jumps to that position in the current track.              |
| `volume`        | `level` 0 to 1                                    | Sets the app's own volume, not the phone's.               |
| `shuffle`       | `on` boolean                                      | Turns shuffle mode on or off.                             |
| `repeat`        | `mode`: `off`, `all` or `one`                     | Sets the repeat mode.                                     |
| `play_album`    | `id`, optional `shuffle` boolean                  | Plays the album with that id.                             |
| `play_playlist` | `id`, optional `shuffle` boolean                  | Plays the playlist with that id.                          |
| `play_artist`   | `id`, optional `shuffle` boolean                  | Plays the artist's popular songs, or the discography.     |
| `play_search`   | `query`                                           | Plays the first song matching the search, the rest queued. |
| `play_favorites`| optional `shuffle` boolean                        | Plays the starred songs.                                  |
| `play_random`   |                                                   | Plays random songs from the library.                      |
| `sleep_timer`   | `minutes` (0 cancels, at most 600)                 | Starts or cancels the sleep timer.                        |

An unknown command is ignored (with a warning in the JS log). The ids are the
server's: the same ones the app's share links and `resonuls://play/album/<id>`
links carry, and what the Navidrome web interface shows in its URLs.

### From `adb shell`

`-p` names the package, which is what lets the broadcast reach a receiver
declared in a manifest on Android 8 and later. `-n` with the receiver's class
works as well.

```sh
PKG=com.hellsss.resonuls
A=com.hellsss.resonuls.COMMAND

adb shell am broadcast -p $PKG -a $A --es command play
adb shell am broadcast -p $PKG -a $A --es command pause
adb shell am broadcast -p $PKG -a $A --es command toggle
adb shell am broadcast -p $PKG -a $A --es command stop
adb shell am broadcast -p $PKG -a $A --es command next
adb shell am broadcast -p $PKG -a $A --es command previous
adb shell am broadcast -p $PKG -a $A --es command seek --ei position 90
adb shell am broadcast -p $PKG -a $A --es command volume --ef level 0.5
adb shell am broadcast -p $PKG -a $A --es command shuffle --ez on true
adb shell am broadcast -p $PKG -a $A --es command repeat --es mode all
adb shell am broadcast -p $PKG -a $A --es command play_album --es id 3f2b9c0e1a5d4e7f8b6c
adb shell am broadcast -p $PKG -a $A --es command play_album --es id 3f2b9c0e1a5d4e7f8b6c --ez shuffle true
adb shell am broadcast -p $PKG -a $A --es command play_playlist --es id 7a1c2d3e-4f5b-6789-abcd-ef0123456789
adb shell am broadcast -p $PKG -a $A --es command play_artist --es id 9e8d7c6b5a4f3e2d1c0b
adb shell am broadcast -p $PKG -a $A --es command play_search --es query "blue monday"
adb shell am broadcast -p $PKG -a $A --es command play_favorites
adb shell am broadcast -p $PKG -a $A --es command play_random
adb shell am broadcast -p $PKG -a $A --es command sleep_timer --ei minutes 30
adb shell am broadcast -p $PKG -a $A --es command sleep_timer --ei minutes 0
```

The full receiver name, for tools that want it: `-n
com.hellsss.resonuls/expo.modules.intentsapi.IntentsApiReceiver`.

### From Tasker

Action **System > Send Intent**:

- Action: `com.hellsss.resonuls.COMMAND`
- Extra: `command:play_album`
- Extra: `id:3f2b9c0e1a5d4e7f8b6c`
- Package: `com.hellsss.resonuls`
- Target: **Broadcast Receiver**

MacroDroid ("Send Intent") and Automate ("Send broadcast") take the same
fields. An NFC app that can send intents (Tasker with an NFC trigger, or NFC
Tools with a "Send intent" task) can do the same from a tag; the simpler
alternative for a tag is a plain URL record `resonuls://play/album/<id>`, which
needs no automation app at all. The same links take `playlist/<id>` and
`artist/<id>`, and three that need no id: `resonuls://play/foryou` starts a mix built from what this phone plays,
`resonuls://play/random` shuffles the
whole library, `resonuls://play/favorites` shuffles the starred songs and
`resonuls://play/resume` picks up the queue, or the last one saved when the
queue is empty. These three are also the app's launcher shortcuts.

## When the app is not running

A broadcast reaches the receiver even when Resonus is closed: Android starts
the process for it. The command is then kept in memory while the app's
JavaScript side is started behind it, with nothing drawn and nothing brought
to the front, and it runs once the profile and the saved queue are back. A
command kept for more than a minute without that happening is dropped rather
than played back later.

Nothing has to be granted for this. Earlier versions opened the app the way
the launcher would, which from Android 10 the system refuses to an app with
nothing on screen unless it may **draw over other apps**; that route is now
only a fallback. Should a command not get through, it can still be sent to
the main activity instead of the receiver, which the system always allows
from a shell or from an automation app that has the permission itself (Tasker
does), at the cost of bringing the app to the front. The extras are the
same:

```sh
adb shell am start -n com.hellsss.resonuls/.MainActivity --es command play_album --es id 3f2b9c0e1a5d4e7f8b6c
```

In Tasker that is the same Send Intent with **Target: Activity** and Class
`com.hellsss.resonuls.MainActivity`. This route also works while the app is
running; it just brings it to the front as well. Sending `play_album` and the
like with the app already open is what the receiver is for.

## State broadcast

After every change of track and every play/pause, Resonus sends the broadcast
`com.hellsss.resonuls.STATE` with these extras:

| Extra        | Type    |                                                       |
| ------------ | ------- | ----------------------------------------------------- |
| `playing`    | boolean |                                                       |
| `id`         | string  | The song's id; empty when the queue is empty.         |
| `title`      | string  | For a radio, what the stream says it is playing.      |
| `artist`     | string  |                                                       |
| `album`      | string  |                                                       |
| `duration`   | double  | Seconds.                                              |
| `position`   | double  | Seconds, at the moment of the change.                 |

A change of whether it is playing or of which song is always sent at once.
Other changes (a radio renaming its song) are held to one a second. Nothing is sent while a song simply plays on: the position is only
current at the moment of the event.

The broadcast is implicit, so it reaches receivers registered at runtime,
which is how Tasker's **Event > System > Intent Received** (action
`com.hellsss.resonuls.STATE`) and MacroDroid's "Intent Received" trigger
listen; a receiver declared in another app's manifest would not get it. In
Tasker the extras arrive as local variables named after them (`%playing`,
`%title`, `%artist`, ...).

Every command received and every state sent is also logged, which is the
quickest check from a shell:

```sh
adb logcat -s IntentsApi
```

## Security

The receiver is exported and protected by nothing: any app on the phone can
control playback, the same as it can press the media buttons through the
system. Nothing it can do reaches the account, the library or the settings.
There is no token, since a token any app could read from the phone would be
no protection.
