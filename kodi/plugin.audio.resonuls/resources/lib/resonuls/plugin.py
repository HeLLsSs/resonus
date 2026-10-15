"""The browsing side: Kodi calls this once per screen, with the screen's
address in `sys.argv`."""

import os
import random
import sys
import urllib.parse

import xbmc
import xbmcgui
import xbmcplugin

from . import kodi
from .kodi import text
from .home import tiles_alive
from .subsonic import SubsonicError, as_list, card_target, clean_title, is_online

PAGE = 50
ALBUM_LISTS = (
    ("newest", 30001),
    ("recent", 30012),
    ("frequent", 30002),
    ("random", 30003),
    ("alphabeticalByName", 30005),
)


def sections(navifind):
    """The add-on's first screen, as (string id, icon, address parameters).
    Kodi's Music menu lists the same, see `menu.py`, and opens each as a
    folder: an entry that played something instead would show as an error
    there."""
    entries = [
        (30073, "special://home/addons/{}/resources/icon.png".format(kodi.ADDON_ID), {"action": "home"}),
        (30010, "DefaultMusicRecentlyPlayed.png", {"action": "saved_queue"}),
    ]
    entries += [(label, "DefaultMusicAlbums.png", {"action": "albums", "kind": kind}) for kind, label in ALBUM_LISTS]
    entries += [
        (30004, "DefaultMusicArtists.png", {"action": "artists"}),
        (30013, "DefaultMusicPlaylists.png", {"action": "playlists"}),
        (30007, "DefaultMusicTop100.png", {"action": "starred"}),
        (30009, "DefaultMusicSongs.png", {"action": "songs", "source": "random"}),
    ]
    if navifind:
        entries.append((30011, "DefaultMusicVideos.png", {"action": "youtube"}))
    entries.append((30008, "DefaultMusicSearch.png", {"action": "search"}))
    return entries


class Plugin:
    def __init__(self, argv):
        self.base = argv[0]
        self.handle = int(argv[1])
        self.params = dict(urllib.parse.parse_qsl(argv[2].lstrip("?")))
        self.client = kodi.client()

    def link(self, **params):
        return self.base + "?" + urllib.parse.urlencode(params)

    def run(self):
        if self.client is None:
            xbmcgui.Dialog().ok("Resonuls", text(30050))
            kodi.addon().openSettings()
            return
        action = self.params.get("action", "root")
        try:
            getattr(self, "do_" + action)()
            if action in ("queue", "resume") and self.handle >= 0:
                xbmcplugin.endOfDirectory(self.handle, succeeded=False)
        except SubsonicError as error:
            kodi.log("{} failed: {}".format(action, error), xbmc.LOGWARNING)
            xbmcgui.Dialog().notification("Resonuls", str(error), xbmcgui.NOTIFICATION_ERROR)
            if self.handle >= 0 and action != "play":
                xbmcplugin.endOfDirectory(self.handle, succeeded=False)
            elif action == "play":
                xbmcplugin.setResolvedUrl(self.handle, False, xbmcgui.ListItem())

    # ── list items ──────────────────────────────────────────────────────────

    def folder(self, label, icon="DefaultMusicAlbums.png", art=None, menu=(), **params):
        item = xbmcgui.ListItem(label, offscreen=True)
        item.setArt(art or {"icon": icon, "thumb": icon})
        item.addContextMenuItems(list(menu))
        return (self.link(**params), item, True)

    def command(self, label, icon, **params):
        """An entry that does something (plays a queue) rather than open. A
        folder, which `run` declines to open once it has played: Kodi queues
        every other entry of a list with the song clicked in it, and would
        play this one as a song after or before it."""
        item = xbmcgui.ListItem(label, offscreen=True)
        item.setArt({"icon": icon, "thumb": icon})
        return (self.link(**params), item, True)

    def cover(self, cover_id):
        url = self.client.cover_url(cover_id)
        return {"thumb": url, "icon": url, "fanart": url} if url else {"icon": "DefaultAudio.png"}

    def song_item(self, song):
        title = clean_title(song)
        item = xbmcgui.ListItem(title, offscreen=True)
        tag = item.getMusicInfoTag()
        tag.setMediaType("song")
        tag.setTitle(title)
        tag.setArtist(song.get("artist") or "")
        tag.setAlbum(song.get("album") or "")
        tag.setDuration(int(song.get("duration") or 0))
        tag.setTrack(int(song.get("track") or 0))
        tag.setDisc(int(song.get("discNumber") or 0))
        tag.setYear(int(song.get("year") or 0))
        if song.get("genre"):
            tag.setGenres([song["genre"]])
        if is_online(song["id"]):
            tag.setComment(song.get("source") or "")
        item.setArt(self.cover(song.get("coverArt")))
        item.setProperty("IsPlayable", "true")
        item.addContextMenuItems(self.song_menu(song))
        return (self.link(action="play", id=song["id"]), item, False)

    def song_menu(self, song):
        menu = [(text(30035), "RunPlugin({})".format(self.link(action="queue", source="similar", id=song["id"])))]
        if is_online(song["id"]):
            if kodi.navifind():
                menu.append((text(30034), "RunPlugin({})".format(self.link(action="library", id=song["id"]))))
        else:
            starred = bool(song.get("starred"))
            menu.append((
                text(30033 if starred else 30032),
                "RunPlugin({})".format(self.link(action="unstar" if starred else "star", id=song["id"])),
            ))
            if song.get("albumId"):
                menu.append((text(30036), "Container.Update({})".format(self.link(action="album", id=song["albumId"]))))
        if song.get("artistId") and not is_online(song["id"]):
            menu.append((text(30037), "Container.Update({})".format(self.link(action="artist", id=song["artistId"]))))
        return menu

    def album_item(self, album):
        label = album.get("name") or ""
        if album.get("artist"):
            label = "{} - {}".format(album["artist"], label)
        entry = self.folder(label, art=self.cover(album.get("coverArt")), action="album", id=album["id"])
        tag = entry[1].getMusicInfoTag()
        tag.setMediaType("album")
        tag.setAlbum(album.get("name") or "")
        tag.setArtist(album.get("artist") or "")
        tag.setYear(int(album.get("year") or 0))
        entry[1].addContextMenuItems([
            (text(30031), "RunPlugin({})".format(self.link(action="queue", source="album", id=album["id"], shuffle=1))),
            (text(30032), "RunPlugin({})".format(self.link(action="star", album=album["id"]))),
        ])
        return entry

    def artist_item(self, artist):
        return self.folder(
            artist.get("name") or "",
            art=self.cover(artist.get("coverArt")),
            action="artist",
            id=artist["id"],
        )

    def show(self, entries, content="", sort=False, title=""):
        xbmcplugin.addDirectoryItems(self.handle, entries, len(entries))
        if content:
            xbmcplugin.setContent(self.handle, content)
        if title:
            xbmcplugin.setPluginCategory(self.handle, title)
        # Without a sort method, Kodi labels the list as sorted by date.
        xbmcplugin.addSortMethod(self.handle, xbmcplugin.SORT_METHOD_LABEL_IGNORE_THE if sort else xbmcplugin.SORT_METHOD_UNSORTED)
        xbmcplugin.endOfDirectory(self.handle)

    def play_header(self, source, **params):
        """"Play all" and "Shuffle" on top of a list of songs: a click on one
        song plays that song alone."""
        return [
            self.command(text(30030), "DefaultMusicPlaylists.png", action="queue", source=source, **params),
            self.command(text(30031), "DefaultMusicSongs.png", action="queue", source=source, shuffle=1, **params),
        ]

    def show_songs(self, source, songs, title="", **params):
        entries = self.play_header(source, **params) if songs else []
        self.show(entries + [self.song_item(song) for song in songs], "songs", title=title)

    # ── screens ─────────────────────────────────────────────────────────────

    def do_root(self):
        self.show([self.folder(text(label), icon, **params) for label, icon, params in sections(kodi.navifind())])

    def do_home(self):
        """The tiled home, over the add-on's first screen: back from it lands
        there. Run as a script of its own, since a list that Kodi is waiting
        on cannot hold a window open."""
        if not tiles_alive():
            script = os.path.join(kodi.addon().getAddonInfo("path"), "home.py")
            xbmc.executebuiltin("RunScript({})".format(script))
        self.do_root()

    def do_albums(self):
        kind = self.params["kind"]
        offset = int(self.params.get("offset", 0))
        albums = self.client.album_list(kind, PAGE, offset)
        entries = [self.album_item(album) for album in albums]
        if len(albums) == PAGE:
            entries.append(self.folder(text(30039), "DefaultFolder.png", action="albums", kind=kind, offset=offset + PAGE))
        self.show(entries, "albums")

    def do_artists(self):
        self.show([self.artist_item(artist) for artist in self.client.artists()], "artists", sort=True)

    def do_artist(self):
        artist = self.client.artist(self.params["id"])
        entries = [self.folder(text(30038), "DefaultMusicTop100.png", action="songs", source="top", name=artist.get("name") or "")]
        entries += [self.album_item(album) for album in as_list(artist.get("album"))]
        self.show(entries, "albums")

    def do_album(self):
        album = self.client.album(self.params["id"])
        self.show_songs("album", as_list(album.get("song")), title=album.get("name") or "", id=self.params["id"])

    def do_playlists(self):
        entries = []
        for playlist in self.client.playlists():
            label = "{} ({})".format(playlist.get("name") or "", playlist.get("songCount", 0))
            entries.append(self.folder(label, art=self.cover(playlist.get("coverArt")), action="playlist", id=playlist["id"]))
        self.show(entries, "albums")

    def do_playlist(self):
        self.show_songs("playlist", self.songs("playlist", self.params["id"]), id=self.params["id"])

    def do_starred(self):
        starred = self.client.starred()
        entries = [self.artist_item(artist) for artist in as_list(starred.get("artist"))]
        entries += [self.album_item(album) for album in as_list(starred.get("album"))]
        songs = as_list(starred.get("song"))
        if songs:
            entries += self.play_header("starred")
        self.show(entries + [self.song_item(song) for song in songs], "songs")

    def do_songs(self):
        source = self.params["source"]
        key = self.params.get("id") or self.params.get("name")
        self.show_songs(source, self.songs(source, key), **{k: v for k, v in self.params.items() if k in ("id", "name")})

    def do_search(self):
        query = self.params.get("query") or xbmcgui.Dialog().input(text(30057))
        if not query:
            xbmcplugin.endOfDirectory(self.handle, succeeded=False)
            return
        found = self.client.search(query)
        entries = [self.artist_item(artist) for artist in found["artist"]]
        entries += [self.album_item(album) for album in found["album"]]
        entries += [self.song_item(song) for song in found["song"]]
        if not entries:
            xbmcgui.Dialog().notification("Resonuls", text(30058))
        self.show(entries, "songs")

    # ── YouTube, through navifind ───────────────────────────────────────────

    def do_youtube(self):
        # The account is the proxy's, signed in from the app: Kodi only reads
        # it. Without it the home page is the one a stranger gets.
        state = self.client.youtube_account().get("state")
        signed_in = state == "ok"
        if state in ("none", "expired"):
            # Named, since it is the account set in this add-on's settings
            # that the app has to be signed in with to fix it.
            xbmcgui.Dialog().notification("Resonuls", text(30061 if state == "none" else 30062).format(self.client.user))
        entries = [self.folder(text(30020), "DefaultMusicVideos.png", action="youtube_home", personal=int(signed_in))]
        if signed_in:
            entries += [
                self.folder(text(30021), "DefaultMusicPlaylists.png", action="youtube_playlists"),
                self.folder(text(30022), "DefaultMusicTop100.png", action="songs", source="youtube_liked"),
            ]
        self.show(entries)

    def do_youtube_home(self):
        entries = []
        for shelf in self.client.youtube_home(self.params.get("personal") == "1"):
            if self.shelf_entries(shelf):
                entries.append(self.folder(shelf.get("title") or "", "DefaultMusicVideos.png", action="youtube_shelf", personal=self.params.get("personal", "0"), shelf=shelf.get("title") or ""))
        self.show(entries)

    def do_youtube_shelf(self):
        # Found again by its title: YouTube does not give the shelves in the
        # same order twice, so a position would open another one.
        shelves = self.client.youtube_home(self.params.get("personal") == "1")
        shelf = next((shelf for shelf in shelves if shelf.get("title") == self.params["shelf"]), {})
        self.show(self.shelf_entries(shelf), "songs")

    def shelf_entries(self, shelf):
        entries = [self.song_item(song) for song in as_list(shelf.get("entry"))]
        for card in as_list(shelf.get("item")):
            entry = self.card_item(card)
            if entry:
                entries.append(entry)
        return entries

    def card_item(self, card):
        target = card_target(card)
        if target is None:
            return None
        art = {"thumb": card.get("thumbnail") or "", "icon": card.get("thumbnail") or ""}
        label = card.get("title") or ""
        if card.get("subtitle"):
            label = "{} - {}".format(label, card["subtitle"])
        kind, target_id = target
        if kind == "song":
            item = xbmcgui.ListItem(label, offscreen=True)
            item.setArt(art)
            item.setProperty("IsPlayable", "true")
            return (self.link(action="play", id=target_id), item, False)
        return self.folder(label, art=art, action="songs", source="youtube_playlist", id=target_id)

    def do_youtube_playlists(self):
        self.show([entry for entry in map(self.card_item, self.client.youtube_my_playlists()) if entry], "albums")

    # ── playing ─────────────────────────────────────────────────────────────

    def songs(self, source, key=None):
        """The songs behind a "play all"; the same lists the screens show."""
        client = self.client
        if source == "album":
            return as_list(client.album(key).get("song"))
        if source == "playlist":
            return as_list(client.playlist(key).get("entry"))
        if source == "starred":
            return as_list(client.starred().get("song"))
        if source == "random":
            return client.random_songs()
        if source == "similar":
            return client.similar_songs(key)
        if source == "top":
            return client.top_songs(key)
        if source == "youtube_liked":
            return client.youtube_liked()
        if source == "youtube_playlist":
            return as_list(client.youtube_playlist(key).get("entry"))
        raise ValueError(source)

    def play_queue(self, songs, start=0, position=0):
        playlist = xbmc.PlayList(xbmc.PLAYLIST_MUSIC)
        playlist.clear()
        for song in songs:
            path, item, _ = self.song_item(song)
            playlist.add(path, item)
        player = xbmc.Player()
        player.play(playlist, startpos=start)
        if position:
            # Seeking before the track has started is ignored.
            monitor = xbmc.Monitor()
            for _ in range(100):
                if player.isPlayingAudio() and player.getTime() > 0:
                    player.seekTime(position)
                    break
                if monitor.waitForAbort(0.1):
                    break

    def do_queue(self):
        songs = self.songs(self.params["source"], self.params.get("id") or self.params.get("name"))
        if self.params.get("shuffle"):
            random.shuffle(songs)
        if songs:
            self.play_queue(songs)
        else:
            xbmcgui.Dialog().notification("Resonuls", text(30058))

    def saved(self):
        """The queue the server saved last, the index of the song it was on
        and who saved it; None when there is nothing to pick up."""
        saved = self.client.play_queue() or {}
        songs = as_list(saved.get("entry"))
        ids = [song["id"] for song in songs]
        if saved.get("current") not in ids:
            return None
        who = saved.get("changedBy") or ""
        if kodi.navifind():
            try:
                who = (self.client.playback("last", kodi.device_id()) or {}).get("name") or who
            except SubsonicError:
                pass
        return songs, ids.index(saved["current"]), int(saved.get("position") or 0) / 1000, who

    def do_saved_queue(self):
        saved = self.saved()
        if saved is None:
            xbmcgui.Dialog().notification("Resonuls", text(30052))
            self.show([])
            return
        songs, index, _, who = saved
        label = text(30060).format(clean_title(songs[index]), who) if who else text(30010)
        entries = [self.command(label, "DefaultMusicRecentlyPlayed.png", action="resume")]
        self.show(entries + [self.song_item(song) for song in songs], "songs")

    def do_resume(self):
        """Picks up the queue the server saved last, from whichever device of
        this account saved it, at the song and the second it was on."""
        saved = self.saved()
        if saved is None:
            xbmcgui.Dialog().notification("Resonuls", text(30052))
            return
        songs, index, position, who = saved
        xbmcgui.Dialog().notification("Resonuls", text(30059).format(who) if who else text(30010))
        self.play_queue(songs, index, position)

    def do_play(self):
        # The song comes with it: a track opened by its address alone, rather
        # than from a list, would otherwise play with no title or cover.
        _, item, _ = self.song_item(self.client.song(self.params["id"]))
        item.setPath(self.client.stream_url(self.params["id"], kodi.max_bitrate()))
        xbmcplugin.setResolvedUrl(self.handle, True, item)

    def do_stream(self):
        """An address the Resonuls app hands Kodi when it plays through it,
        with what to show for it: Kodi's remote control has no way to name
        a file it is given, and the TV would read "stream.view"."""
        p = self.params
        item = xbmcgui.ListItem(p.get("title", ""), path=p["url"], offscreen=True)
        tag = item.getMusicInfoTag()
        tag.setMediaType("song")
        tag.setTitle(p.get("title", ""))
        tag.setArtist(p.get("artist", ""))
        tag.setAlbum(p.get("album", ""))
        tag.setDuration(int(p.get("duration") or 0))
        if p.get("art"):
            item.setArt({"thumb": p["art"], "icon": p["art"], "fanart": p["art"]})
        xbmcplugin.setResolvedUrl(self.handle, True, item)

    # ── context menu ────────────────────────────────────────────────────────

    def do_star(self):
        self.client.star(self.params.get("id"), self.params.get("album"))
        xbmcgui.Dialog().notification("Resonuls", text(30055))
        xbmc.executebuiltin("Container.Refresh")

    def do_unstar(self):
        self.client.unstar(self.params.get("id"), self.params.get("album"))
        xbmcgui.Dialog().notification("Resonuls", text(30056))
        xbmc.executebuiltin("Container.Refresh")

    def do_library(self):
        self.client.add_to_library(self.params["id"])
        xbmcgui.Dialog().notification("Resonuls", text(30054))


def main():
    Plugin(sys.argv).run()
