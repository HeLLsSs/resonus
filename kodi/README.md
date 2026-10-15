# Resonuls for Kodi

[Resonuls](https://github.com/HeLLsSs/resonus) on Kodi: browse and play a
Navidrome (Subsonic) server from the TV, with the extras of a navifind proxy
in front of it.

- **Home**: rows of covers to walk with a TV remote, YouTube Music style
  (shortcuts, YouTube quick picks, recently added and played, most played,
  playlists, random albums). Up and down change row, OK opens or plays,
  the menu key plays an album straight away. "Now playing" opens Kodi's
  player, which also opens by itself when music starts from a tile.
- **In Kodi's Music menu**: every section at the top of it, Home first
  (Settings › Display to turn it off).
- Library: recently added, recently and most played, random albums, A-Z,
  artists (with their top songs), playlists, starred, search, random mix.
- Play all or shuffle on top of every list; song radio, star and "go to
  album/artist" in the context menu.
- **Resume where you stopped**: picks up the queue the server saved last,
  from any device of the account, at the song and second it was on.

Behind navifind (Settings › navifind, on by default):

- **YouTube**: the home shelves (your own once the proxy is signed in), your
  YouTube playlists and liked songs. Online tracks stream through the proxy
  and get filed in the library after ten seconds, like in the app.
- **One account, one music**: Kodi takes the account's playing spot when it
  plays and pauses when another device takes it, with a notification saying
  which one.

Playing to Kodi from the Resonuls app (its Kodi output) goes through the
add-on too, so that the TV shows the title and cover; the app counts those
listens itself.

The background service also sends "now playing", scrobbles past half a track
(four minutes at most) and saves the queue for the other devices to resume.

## Install

Needs Kodi 21 (Omega) or later. The add-on comes from its own Kodi
repository, on this project's GitHub Pages
(`https://hellsss.github.io/resonus/kodi/`), so that Kodi brings each new
version by itself.

On the Kodi box, once:

1. Settings › System › Add-ons: turn on **Unknown sources**.
2. Settings › File manager › Add source: `https://hellsss.github.io/resonus/kodi/`,
   named for instance `Resonuls`.
3. Add-ons › Install from zip file › `Resonuls` › `repository.resonuls.zip`.
4. Add-ons › Install from repository › Resonuls repository › Music add-ons ›
   **Resonuls** › Install.
   "Could not connect to repository" right after step 3 means Kodi has not
   read the repository yet: restart Kodi and try again.
5. Fill in the server address, username and password in the add-on's
   settings (Configure).

Install Resonuls from the repository (step 4) rather than from its zip: Kodi
only updates an add-on from the repository it came from, and one installed
from a zip has none. One that was can be moved over with Update › the
repository's version on its information page.

## Release a version

1. Raise `version` in `plugin.audio.resonuls/addon.xml`, add the version to
   `CHANGELOG.md` and put its summary in the `<news>` of `addon.xml`, which
   Kodi shows when it updates.
2. `./build.sh publish`: builds the repository and pushes it to the
   `gh-pages` branch, which GitHub Pages serves. It stops if that version is
   already out.

Kodi checks its repositories when it starts and once a day, and installs
the new version by itself. `./build.sh` alone builds the repository in
`dist/pages/kodi` without publishing it; `REPO_URL=http://host:port/ ./build.sh`
builds one for another address, to try a release on a test Kodi first.

## Tests

```sh
python3 -m unittest discover -s tests -t tests
```

The tests run the add-on outside Kodi, against fakes of Kodi's modules
(`tests/fake_kodi.py`) and of a Subsonic server (`tests/fake_server.py`).
