# Changelog

The Resonuls add-on for Kodi (`plugin.audio.resonuls`) and its repository
(`repository.resonuls`). Kodi shows the latest entry of the add-on, kept in
the `<news>` of its `addon.xml`, when it installs or updates it.

## plugin.audio.resonuls

### [0.1.2] - 2026-10-15

- "Now playing", on the home of covers and at the top of the add-on's list
  while music plays, opens Kodi's player, where OK brings pause, stop and
  next: a TV remote had no way to it.
- The player opens by itself when music is started from a tile, "Play
  all", "Shuffle" or "Resume"; back returns to where it was started.
- Back from the covers opened from Kodi's Music menu no longer opens new
  covers in their place.
- The covers no longer open by themselves when Kodi starts, nor with Kodi's
  Music section: "Home" opens them.

### [0.1.1] - 2026-10-15

- The home of covers opened when Kodi starts opens search, playlists and
  the other tiles, instead of closing on Kodi's home screen.
- Giving up on a search brings the covers back, rather than leaving them
  hidden behind the list.
- Covers lost behind a list come back by themselves, so "Home" always
  opens them again.
- "Play all", "Shuffle" and "Resume" no longer land in Kodi's queue among
  the songs when a song of the list is clicked.
- A server out of reach is said on screen, instead of a script error that
  closed the list.

### [0.1.0] - 2026-10-15

- First version: the Navidrome library on Kodi (albums, artists,
  playlists, favourites, search, random mix), with Navifind's YouTube
  (home shelves, playlists, liked songs).
- A home of covers for the remote, opened when Kodi starts, and every
  section at the top of Kodi's Music menu.
- Scrobbles and "now playing", resume from another device, and one
  account, one music: Kodi pauses when another device plays.
- Plays what the Resonuls app sends to Kodi, with the title and cover.

## repository.resonuls

### [1.0.0] - 2026-10-15

- The Kodi repository on GitHub Pages
  (https://hellsss.github.io/resonus/kodi/), so that the add-on updates
  itself.
