"""The background side: watches Kodi's player once a second and lets the
session decide what the server hears about it."""

import time

import xbmc
import xbmcgui
import xbmcvfs

from . import kodi, menu
from .kodi import text
from .plugin import sections
from .session import Playing, Session, track_id_of


class Monitor(xbmc.Monitor):
    def __init__(self):
        super().__init__()
        self.changed = True

    def onSettingsChanged(self):
        self.changed = True


def now_playing(player, server_url):
    """What Kodi plays, as a `Playing`, or None when it is not one of ours."""
    try:
        if not player.isPlayingAudio():
            return None
        track_id = track_id_of(player.getPlayingFile(), kodi.PLUGIN_URL, server_url)
        if not track_id:
            return None
        playlist = xbmc.PlayList(xbmc.PLAYLIST_MUSIC)
        queue = [track_id_of(playlist[i].getPath(), kodi.PLUGIN_URL, server_url) for i in range(playlist.size())]
        queue = [queued for queued in queue if queued]
        tag = player.getMusicInfoTag()
        title = " - ".join(part for part in (tag.getArtist(), tag.getTitle()) if part)
        return Playing(
            track_id,
            player.getTime(),
            player.getTotalTime(),
            xbmc.getCondVisibility("Player.Paused"),
            queue if track_id in queue else [track_id],
            title,
        )
    except RuntimeError:
        # Between two tracks the player answers questions about neither.
        return None


def update_menu():
    settings = kodi.addon()
    entries = []
    if settings.getSettingBool("music_menu"):
        entries = [(text(label), icon, params) for label, icon, params in sections(kodi.navifind())]
    try:
        menu.install(
            xbmcvfs.translatePath("special://profile/library/music/"),
            xbmcvfs.translatePath("special://xbmc/system/library/music/"),
            kodi.PLUGIN_URL,
            entries,
        )
    except OSError as error:
        kodi.log("could not change the Music menu: {}".format(error), xbmc.LOGWARNING)


def open_home_at_start(monitor):
    """The tiles as the first thing on screen, for a Kodi kept for music:
    once Kodi's own home is up, so that back from them has somewhere to go.
    Opened from the music window, as from the add-on's list: the tiles show
    what they open in it, and over Kodi's home a tile only closed them."""
    if not kodi.addon().getSettingBool("home_at_start"):
        return
    for _ in range(60):
        if xbmc.getCondVisibility("Window.IsActive(home) + !System.HasModalDialog"):
            xbmc.executebuiltin("ActivateWindow(Music,{}?action=home,return)".format(kodi.PLUGIN_URL))
            return
        if monitor.waitForAbort(1):
            return


def main():
    monitor = Monitor()
    open_home_at_start(monitor)
    player = xbmc.Player()
    session = None
    server_url = ""
    while not monitor.abortRequested():
        if monitor.changed:
            monitor.changed = False
            update_menu()
            if session is not None:
                session.tick(time.monotonic(), None)
            client = kodi.client()
            server_url = client.server_url if client else ""
            session = Session(client, kodi.device_id(), kodi.device_name(), kodi.exclusive(), kodi.log) if client else None
        if session is not None:
            taken_by = session.tick(time.monotonic(), now_playing(player, server_url))
            if taken_by:
                kodi.log("the account now plays on {}".format(taken_by))
                if not xbmc.getCondVisibility("Player.Paused"):
                    player.pause()
                xbmcgui.Dialog().notification("Resonuls", text(30053).format(taken_by), kodi.addon().getAddonInfo("icon"))
        if monitor.waitForAbort(1):
            break
    if session is not None:
        session.tick(time.monotonic(), None)
