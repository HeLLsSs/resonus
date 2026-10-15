"""The tiled home: rows of covers to walk with a TV remote, the way YouTube
Music lays out its home. Up and down go from row to row, left and right
along one, OK opens or plays what is on the tile and the menu key plays an
album straight away. Drawn by `resources/skins/default/1080i/resonuls-home.xml`."""

import time

import xbmc
import xbmcgui

from . import kodi, shelves
from .kodi import text

ROWS = 7
# The window's control ids: one list per row, inside a group with its title.
LIST, GROUP, TITLE = 1000, 2000, 3000
ACTION_BACK = (xbmcgui.ACTION_PREVIOUS_MENU, xbmcgui.ACTION_NAV_BACK)
ACTION_MENU = (xbmcgui.ACTION_CONTEXT_MENU,)
# A beat on Kodi's home window while the tiles are alive: Kodi lists the
# "Home" folder again on the way back from a list, which must not open a
# second set of tiles over the first. A time rather than a flag, so that
# tiles that died without saying so do not keep the next ones from opening.
OPEN = "resonuls.home"
BEAT_SEC = 0.3
STALE_SEC = 3


def tiles_alive():
    beat = xbmcgui.Window(10000).getProperty(OPEN)
    try:
        return time.time() - float(beat) < STALE_SEC
    except ValueError:
        return False
# A list that has not opened by then is not going to: a search given up on.
NEVER_OPENED_SEC = 8
# Tiles out of sight for that long were lost behind the music window.
HIDDEN_SEC = 1.5


def song_item(client, song):
    """A song for Kodi's music playlist, played through the add-on."""
    title = shelves.clean_title(song)
    item = xbmcgui.ListItem(title, offscreen=True)
    tag = item.getMusicInfoTag()
    tag.setMediaType("song")
    tag.setTitle(title)
    tag.setArtist(song.get("artist") or "")
    tag.setAlbum(song.get("album") or "")
    tag.setDuration(int(song.get("duration") or 0))
    cover = client.cover_url(song.get("coverArt"))
    item.setArt({"thumb": cover, "icon": cover})
    item.setProperty("IsPlayable", "true")
    return "{}?{}".format(kodi.PLUGIN_URL, shelves.query(action="play", id=song["id"])), item


class Home(xbmcgui.WindowXML):
    def __init__(self, *args, **kwargs):
        super().__init__(*args)
        self.client = kwargs["client"]
        self.songs = {}
        self.loaded = False
        self.closed = False
        self.focus = LIST
        # Away showing one of the add-on's lists: where the music window was
        # when it went, and whether it has left it yet.
        self.origin = None
        self.left = False
        self.away_since = 0.0
        self.window_id = 0

    def onInit(self):
        self.window_id = xbmcgui.getCurrentWindowId()
        # Called again each time a list opened from here is left: the rows
        # are still there, and so is the tile the remote was on.
        if self.loaded:
            self.setFocusId(self.focus)
            return
        self.loaded = True
        self.setProperty("loading", "true")
        rows, self.songs = shelves.load(self.client, text, kodi.navifind())
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
        self.clearProperty("loading")
        self.setFocusId(LIST)

    def selected(self):
        control = self.getFocusId()
        if not LIST <= control < LIST + ROWS:
            return ""
        item = self.getControl(control).getSelectedItem()
        return item.getProperty("action") if item else ""

    def onClick(self, controlId):
        self.focus = controlId
        self.run(self.selected(), play=False)

    def onAction(self, action):
        if action.getId() in ACTION_BACK:
            self.closed = True
            self.close()
        elif action.getId() in ACTION_MENU:
            self.run(self.selected(), play=True)

    def run(self, action, play):
        word, _, rest = action.partition(":")
        if word in ("album", "playlist"):
            if play:
                xbmc.executebuiltin("RunPlugin({}?{})".format(kodi.PLUGIN_URL, shelves.query(action="queue", source=word, id=rest)))
            else:
                self.open(shelves.query(action=word, id=rest))
        elif word == "song":
            shelf, _, index = rest.partition(":")
            self.play(self.songs.get(shelf, []), int(index))
        elif word == "folder":
            self.open(rest)
        elif word == "run":
            xbmc.executebuiltin("RunPlugin({}?{})".format(kodi.PLUGIN_URL, rest))

    def open(self, params):
        """One of the add-on's lists, in the music window under this one,
        which goes into it the way it goes into a folder: back comes out of
        it to where it was, and `main` shows the tiles again from there.
        Opening it as a window of its own would leave the music window, and
        back would then go to Kodi's home rather than here."""
        self.close()
        xbmc.sleep(100)
        self.origin = xbmc.getInfoLabel("Container.FolderPath")
        self.left = False
        self.away_since = time.monotonic()
        xbmc.executebuiltin("Container.Update({}?{})".format(kodi.PLUGIN_URL, params))

    def back_from_list(self):
        """Whether the list opened from here was left for where it started.
        A list that never opened (a search given up on) counts after a while,
        once the keyboard is gone: shown under it, the tiles were lost."""
        if not xbmc.getCondVisibility("Window.IsActive(music) + !System.HasVisibleModalDialog"):
            return False
        here = xbmc.getInfoLabel("Container.FolderPath")
        if here != self.origin:
            self.left = True
            return False
        return self.left or time.monotonic() - self.away_since > NEVER_OPENED_SEC

    def play(self, songs, start):
        playlist = xbmc.PlayList(xbmc.PLAYLIST_MUSIC)
        playlist.clear()
        for song in songs:
            playlist.add(*song_item(self.client, song))
        xbmc.Player().play(playlist, startpos=start)
        # Opened from the add-on rather than from here, where it was ignored.
        xbmc.executebuiltin("RunPlugin({}?{})".format(kodi.PLUGIN_URL, shelves.query(action="now_playing", wait=1)))


def main():
    client = kodi.client()
    if client is None:
        xbmcgui.Dialog().ok("Resonuls", text(30050))
        return
    window = Home("resonuls-home.xml", kodi.addon().getAddonInfo("path"), "default", "1080i", client=client)
    # Shown rather than modal: Kodi closes a modal window as soon as another
    # one opens, so back from an album would not come back here. The script
    # keeps it alive until it is left.
    home = xbmcgui.Window(10000)
    window.show()
    monitor = xbmc.Monitor()
    hidden = 0
    try:
        while not window.closed and not monitor.waitForAbort(BEAT_SEC):
            home.setProperty(OPEN, str(time.time()))
            if window.origin is None:
                # Shown, yet out of sight under the music window: brought
                # back, or "Home" could not open them, taking them for open.
                visible = xbmc.getCondVisibility("Window.IsVisible({})".format(window.window_id))
                idle = xbmc.getCondVisibility("Window.IsActive(music) + !System.HasVisibleModalDialog")
                hidden = hidden + 1 if window.window_id and idle and not visible else 0
                if hidden * BEAT_SEC >= HIDDEN_SEC:
                    hidden = 0
                    window.show()
                continue
            if window.back_from_list():
                window.origin = None
                window.show()
            elif not xbmc.getCondVisibility("Window.IsActive(music)") and not xbmc.getCondVisibility("System.HasModalDialog"):
                # Left for somewhere else altogether: the tiles are not waiting.
                break
    finally:
        left = window.closed
        window.close()
        if left:
            # Back from the tiles goes to where they were opened from, Kodi's
            # Music menu or the add-on's own first screen, rather than to
            # Kodi's home, which is where closing them lands otherwise.
            back = "library://music/" if kodi.addon().getSettingBool("music_menu") else kodi.PLUGIN_URL
            xbmc.executebuiltin("ActivateWindow(Music,{},return)".format(back))
        # A last beat rather than none: closing the tiles has Kodi list the
        # add-on's "Home" again, which would open new ones over the way out.
        home.setProperty(OPEN, str(time.time()))
        del window
