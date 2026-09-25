# Resonus in Home Assistant

Home Assistant can browse and search the library, start music on this phone
or send it to one of the house's speakers, and see what is playing, from the
standard media control card. It takes a custom integration on the Home
Assistant side, `resonus`, and two things on the phone: this app, and the
Home Assistant Companion app.

This is the phone as a **player**. Playing to the house's speakers from the
phone is the other direction and is set up on the same screen; see the output
sheet. The two meet: a speaker picked on the card is one the sheet would
have picked, and the phone does the playing either way.

## How it works

Neither half polls anything. The state and the library stay on the network;
a command travels as a Companion app notification, which goes around by
Google's push servers unless that app is set to local push (its Settings ›
Notifications, push channel: WebSocket). Worth turning on.

**Home Assistant → the app.** A command is a notification to the Companion
app, which broadcasts an intent (see [INTENTS.md](INTENTS.md)). That reaches
the app whether it is open, in the background or closed, and needs nothing
granted. The card's buttons are the intents API's `play`, `pause`, `next`,
`seek`, `volume`, `shuffle`, `repeat`, `play_album`, `play_playlist`,
`play_artist`, `play_song` and `output`.

**The app → Home Assistant.** What is playing is pushed to a webhook the
integration holds open (`src/lib/haBridge.ts`), on every change worth a
repaint of the card: the track, play or pause, a seek, the volume, the
output. A tick of the clock is not one of them — the card counts the seconds
between pushes by itself.

**Where it plays** is the player's source, and a `select` entity of its own
for a dashboard: this phone, or any of the house's media players a URL can
be handed to, the same list the output sheet shows under Home Assistant.
Picking one sends `output` with the player's entity id, and the phone hands
that speaker the queue exactly as the sheet would have; picking the phone
brings the music back. A Chromecast, a renderer or a LinkPlay speaker chosen
on the phone itself shows on the card by name, since the card cannot pick
those: the phone finds them on the network, and Home Assistant holds no id
for them.

**Search** is the field at the top of the browser's directories, and a
`Search` directory at its root that is nothing but that field. It is
answered by the integration from the music server, so a phone that is
asleep is no obstacle. The field needs Home Assistant 2026.8 or later; the
integration loads on 2025.6 and later without it.

**On a restart**, Home Assistant has nothing: a push is one way and what it
held is gone. It asks, with `publish_state`, and the phone pushes again. A
phone that is away does not answer, and the card stays idle until it next
plays something.

**The library** is read by the integration from the music server directly,
not from the phone, so the browser answers with the screen off.

## Setting it up

1. On the phone, **Settings › Home Assistant**, switch it on. The address and
   token are what the output sheet needs; the **webhook identifier** shown
   further down is what the integration needs. Press and hold to copy it.
2. Install the Companion app on the same phone, so Home Assistant has a
   `notify.mobile_app_…` service for it.
3. Install the `resonus` integration (HACS, or copied into `custom_components`)
   and add it: a name for the card, the music server's address and
   credentials, the phone's notify service and that webhook identifier.
4. Exclude the phone from Android's battery optimisation. A tablet on a wall
   with a music app the system is free to kill is a card that stops
   answering.

## The address must be the local one

The integration only takes a push from the network the house is on, never
through Nabu Casa or a reverse proxy on the internet, so the address on the
phone's Home Assistant screen has to be the local one
(`http://homeassistant.local:8123`, or the IP). A remote address there plays
to the house's speakers all the same and never reaches the card.

## What the identifier is

Half of an address, and nothing secret: a webhook takes no token, so what
keeps a push private is that nobody else on the network knows where it goes.
It is made once, the first time the screen is opened with the switch on, and
kept from then on, because the integration on the other side is set up with
it.
