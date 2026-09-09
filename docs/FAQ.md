# FAQ

Not here? Ask on [Discord](https://discord.gg/pecE8MTPVr) or open an
[issue](https://github.com/juananzzz/resonus/issues).

## How do I get Resonus to show up in Android Auto?

Android Auto only lists apps it got from the Play Store, so it has to be told to
accept the rest. The switch is on the phone and you only set it once:

1. Open Android Auto's settings on the phone (Settings › Connected devices ›
   Android Auto, or the Android Auto app).
2. Tap **Version** about ten times, until it offers to turn on developer
   settings. Accept.
3. Go to **Developer settings** and turn on **Unknown sources**.
4. Connect the phone to the car again.

Resonus should be in the car's app list from then on.

## My server is behind Cloudflare Access (or another proxy that wants a header). What works?

Sign in with the header under **Advanced**, one `Name: value` per line. It goes
with every request the app makes: browsing, streaming, covers, downloads,
lyrics.

Casting is the one place where something else does the fetching, and the
speaker cannot be told about the header, so the app goes round it:

- **Google Cast and UPnP/DLNA**: the speaker is handed an address on the phone
  instead of the server's, and the phone fetches from the server with the
  header on and passes the stream through. The header never leaves the phone.
  The phone has to stay awake and on the same Wi-Fi for as long as it plays,
  the same as when it casts a download. A downloaded song is served straight
  off the phone.

## How do I install Resonus on iOS?

Resonus on iOS is provided as an unsigned .ipa file, so it has to be sideloaded.

There are various sideloading methods available on iOS and anyone that can install an unsigned ipa works fine.
The sideloading methods we suggest are:
1. SideStore:
   Official guide (requires a PC) [Prerequisites](https://docs.sidestore.io/docs/installation/prerequisites), [Installation](https://docs.sidestore.io/docs/installation/install)<br>
   Unofficial method (on device, doesn't require a PC) [SideInstaller guide](https://sideinstaller.net/)
2. AltStore:
   Official guide (requires a PC) [Windows](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows), [MacOS](https://faq.altstore.io/altstore-classic/how-to-install-altstore-macos)

You can also [add Resonus repository as an altsource](https://altdirect.app/?url=https://raw.githubusercontent.com/juananzzz/resonus/main/Source.json).
