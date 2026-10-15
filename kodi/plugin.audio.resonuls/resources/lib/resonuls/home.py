"""The Resonuls app: rows of covers to walk with a TV remote, the way YouTube
Music lays out its home, and the add-on's lists, all in windows of its own.
Up and down go from row to row, left and right along one, OK opens or plays
what is on the tile and the menu key plays an album straight away. A bar at
the top pauses, stops or skips what plays. Drawn by
`resources/skins/default/1080i/resonuls-home.xml` and `resonuls-list.xml`.

It never goes through Kodi's music window: a list opened there could take
the remote to Kodi's own menus whenever Kodi changed window."""

import json
import time

import xbmc
import xbmcgui

from . import kodi, screens, shelves
from .kodi import text

ROWS = 7
# The windows' control ids: one list per row of tiles, inside a group with
# its title; the list of a list window.
LIST, GROUP, TITLE = 1000, 2000, 3000
ENTRIES = 100
# The now-playing bar's buttons: play or pause, stop, next, Kodi's player.
BAR = (501, 502, 503, 504)
# Closes the app, for a remote whose back key does not.
CLOSE = 510
ACTION_BACK = (xbmcgui.ACTION_PREVIOUS_MENU, xbmcgui.ACTION_NAV_BACK)
ACTION_MENU = (xbmcgui.ACTION_CONTEXT_MENU,)
# Kodi's windows the app may be under while it runs: its music player and
# its video player.
PLAYERS = (12006, 12005)
MUSIC_WINDOW = 10502
# A beat on Kodi's home window while the app is open: Kodi lists the
# add-on's "Home" folder again on the way back from it, which must not open
# a second app over the first. A time rather than a flag, so that an app
# that died without saying so does not keep the next one from opening.
OPEN = "resonuls.home"
BEAT_SEC = 0.3
STALE_SEC = 3
# A window Kodi has not drawn by then is not going to be (a dialog in the way).
NEVER_SHOWN_SEC = 6
# Out of the app for that long (Kodi's home key): it closes.
AWAY_SEC = 2


def tiles_alive():
    beat = xbmcgui.Window(10000).getProperty(OPEN)
    try:
        return time.time() - float(beat) < STALE_SEC
    except ValueError:
        return False


def browse(path):
    """One of the add-on's lists, as Kodi's JSON-RPC lists it."""
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "Files.GetDirectory",
        "params": {"directory": path, "media": "music", "properties": ["title", "artist", "duration", "thumbnail", "art"]},
    }
    answer = json.loads(xbmc.executeJSONRPC(json.dumps(request)))
    return answer.get("result", {}).get("files") or []


def song_item(path, title, artist, duration, cover):
    """A song for Kodi's music playlist, played through the add-on."""
    item = xbmcgui.ListItem(title, offscreen=True)
    tag = item.getMusicInfoTag()
    tag.setMediaType("song")
    tag.setTitle(title)
    tag.setArtist(artist)
    tag.setDuration(int(duration or 0))
    item.setArt({"thumb": cover, "icon": cover})
    item.setProperty("IsPlayable", "true")
    return path, item


def song_of(entry):
    """A song of one of the add-on's lists, as JSON-RPC lists it, for Kodi's playlist."""
    return song_item(
        entry["file"],
        entry.get("title") or entry.get("label") or "",
        ", ".join(entry.get("artist") or []),
        entry.get("duration"),
        entry.get("thumbnail") or "",
    )


def play(songs, start):
    """`songs` as (path, item): played from `start` on."""
    playlist = xbmc.PlayList(xbmc.PLAYLIST_MUSIC)
    playlist.clear()
    for path, item in songs:
        playlist.add(path, item)
    xbmc.Player().play(playlist, startpos=start)


def run_plugin(query):
    xbmc.executebuiltin("RunPlugin({}?{})".format(kodi.PLUGIN_URL, query))


class AppWindow(xbmcgui.WindowXML):
    """One window of the app: back closes it, and the app shows the one under."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args)
        self.app = kwargs["app"]
        self.loaded = False
        self.closed = False
        self.window_id = 0
        self.focus = 0
        self.opened = time.monotonic()

    def onInit(self):
        self.window_id = xbmcgui.getCurrentWindowId()
        # Called again each time the window comes back: the list is still
        # there, and so is where the remote was.
        if self.loaded:
            if self.focus:
                self.setFocusId(self.focus)
            return
        self.loaded = True
        self.setProperty("loading", "true")
        self.load()
        self.clearProperty("loading")

    def onAction(self, action):
        if action.getId() in ACTION_BACK:
            self.closed = True
            self.close()

    def onClick(self, controlId):
        if controlId == CLOSE:
            self.app.leaving = True

    def load(self):
        raise NotImplementedError


class Home(AppWindow):
    content = LIST

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.songs = {}

    title = "Resonuls"

    def rows(self):
        return shelves.load(self.app.client, text, kodi.navifind())

    def load(self):
        self.setProperty("title", self.title)
        rows, self.songs = self.rows()
        for i in range(ROWS):
            listing = self.getControl(LIST + i)
            listing.reset()
            if i >= len(rows):
                continue
            title, tiles = rows[i]
            self.getControl(TITLE + i).setLabel(title)
            items = []
            for t in tiles:
                item = xbmcgui.ListItem(t["label"], t["label2"], offscreen=True)
                item.setArt({"thumb": t["art"], "icon": t["art"]})
                for key in ("action", "kind", "colour"):
                    item.setProperty(key, t[key])
                items.append(item)
            listing.addItems(items)
        self.setFocusId(LIST)

    def selected(self):
        control = self.getFocusId()
        if not LIST <= control < LIST + ROWS:
            return None
        return self.getControl(control).getSelectedItem()

    def onClick(self, controlId):
        if LIST <= controlId < LIST + ROWS:
            self.focus = controlId
            self.run(self.selected(), play_now=False)
        else:
            super().onClick(controlId)

    def onAction(self, action):
        if action.getId() in ACTION_MENU:
            self.run(self.selected(), play_now=True)
        else:
            super().onAction(action)

    def run(self, item, play_now):
        if item is None:
            return
        word, _, rest = item.getProperty("action").partition(":")
        if word in ("album", "playlist"):
            if play_now:
                run_plugin(shelves.query(action="queue", source=word, id=rest))
            else:
                self.app.open(shelves.query(action=word, id=rest), item.getLabel())
        elif word == "song":
            shelf, _, index = rest.partition(":")
            client = self.app.client
            songs = [
                song_item(
                    "{}?{}".format(kodi.PLUGIN_URL, shelves.query(action="play", id=song["id"])),
                    shelves.clean_title(song),
                    song.get("artist") or "",
                    song.get("duration"),
                    client.cover_url(song.get("coverArt")),
                )
                for song in self.songs.get(shelf, [])
            ]
            play(songs, int(index))
            run_plugin(shelves.query(action="now_playing", wait=1))
        elif word == "folder":
            self.app.open(rest, item.getLabel())
        elif word == "youtube":
            self.app.push(YouTube("resonuls-home.xml", self.app.path, "default", "1080i", app=self.app))
        elif word == "run":
            run_plugin(rest)


class YouTube(Home):
    """The YouTube screen, as the app's YouTube tab lays it out: its die and
    the account's own lists, then the shelves of the YouTube home page."""

    title = "YouTube"

    def rows(self):
        return shelves.youtube_rows(self.app.client, text)


class ListWindow(AppWindow):
    """One of the add-on's lists: an album, a playlist, a search…"""

    content = ENTRIES

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.path = kwargs["path"]
        self.title = kwargs["title"]
        # Listed already by the app, which had to see whether it held one song.
        self.entries = kwargs["entries"]

    def load(self):
        self.setProperty("title", self.title)
        listing = self.getControl(ENTRIES)
        listing.reset()
        items = []
        for entry in self.entries:
            item = xbmcgui.ListItem(entry.get("label") or "", ", ".join(entry.get("artist") or []), offscreen=True)
            thumb = screens.art_of(entry)
            item.setArt({"thumb": thumb, "icon": thumb})
            item.setProperty("kind", screens.kind_of(entry, kodi.PLUGIN_URL))
            items.append(item)
        listing.addItems(items)
        if not items:
            self.setProperty("empty", "true")
        self.setFocusId(ENTRIES)

    def onClick(self, controlId):
        if controlId != ENTRIES:
            super().onClick(controlId)
            return
        if not self.entries:
            return
        self.focus = ENTRIES
        entry = self.entries[self.getControl(ENTRIES).getSelectedPosition()]
        kind = screens.kind_of(entry, kodi.PLUGIN_URL)
        if kind == "open":
            self.app.open(entry["file"], entry.get("label") or "")
        elif kind == "run":
            xbmc.executebuiltin("RunPlugin({})".format(entry["file"]))
        elif kind == "song":
            # The list's songs from this one on, as Kodi does with a list.
            songs = [e for e in self.entries if screens.kind_of(e, kodi.PLUGIN_URL) == "song"]
            play([song_of(e) for e in songs], songs.index(entry))


class App:
    def __init__(self, client):
        self.client = client
        self.path = kodi.addon().getAddonInfo("path")
        self.stack = []
        self.leaving = False

    def push(self, window):
        self.stack.append(window)
        window.show()

    def open(self, query_or_path, title):
        path = query_or_path if query_or_path.startswith("plugin://") else "{}?{}".format(kodi.PLUGIN_URL, query_or_path)
        if screens.action_of(path) == "search" and "query=" not in path:
            query = xbmcgui.Dialog().input(text(30057))
            if not query:
                return
            path = screens.with_query(path, query)
            title = "{} : {}".format(title, query)
        entries = [e for e in browse(path) if screens.kind_of(e, kodi.PLUGIN_URL)]
        lone = screens.lone_song(entries, kodi.PLUGIN_URL)
        if lone is not None:
            play([song_of(lone)], 0)
            run_plugin(shelves.query(action="now_playing", wait=1))
            return
        self.push(ListWindow("resonuls-list.xml", self.path, "default", "1080i", app=self, path=path, title=title, entries=entries))

    def run(self):
        home = xbmcgui.Window(10000)
        origin = xbmcgui.getCurrentWindowId()
        origin_path = xbmc.getInfoLabel("Container.FolderPath")
        self.push(Home("resonuls-home.xml", self.path, "default", "1080i", app=self))
        monitor = xbmc.Monitor()
        away = 0
        try:
            while self.stack and not self.leaving and not monitor.waitForAbort(BEAT_SEC):
                home.setProperty(OPEN, str(time.time()))
                top = self.stack[-1]
                if top.closed:
                    self.stack.pop()
                    if self.stack:
                        self.stack[-1].show()
                    continue
                if not top.window_id and time.monotonic() - top.opened > NEVER_SHOWN_SEC:
                    # Kodi would not show it: given up rather than asked
                    # again and again, which would hold what is in the way.
                    break
                current = xbmcgui.getCurrentWindowId()
                if current == top.window_id and top.getFocusId() in BAR and not xbmc.getCondVisibility("Player.HasAudio"):
                    # The bar went with the music, and the remote with it.
                    top.setFocusId(top.content)
                if current == top.window_id or current in PLAYERS or xbmc.getCondVisibility("System.HasModalDialog"):
                    away = 0
                    continue
                if current == origin and top.window_id:
                    # Kodi went back under the app on its own: brought back.
                    top.show()
                    continue
                away += 1
                if away * BEAT_SEC >= AWAY_SEC:
                    break
        finally:
            for window in reversed(self.stack):
                window.close()
            if origin == MUSIC_WINDOW and xbmcgui.getCurrentWindowId() != MUSIC_WINDOW:
                # Back to the list it was opened from, rather than to Kodi's
                # home, where closing it lands otherwise.
                xbmc.executebuiltin("ActivateWindow(Music,{},return)".format(origin_path))
            # A last beat rather than none: closing the app has Kodi list the
            # add-on's "Home" again, which would open a new one.
            home.setProperty(OPEN, str(time.time()))


def main():
    client = kodi.client()
    if client is None:
        xbmcgui.Dialog().ok("Resonuls", text(30050))
        return
    if not tiles_alive():
        App(client).run()
