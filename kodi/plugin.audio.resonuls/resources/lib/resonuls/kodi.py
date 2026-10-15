"""What the plugin and the service share: settings, strings and the client."""

import os
import uuid

import xbmc
import xbmcaddon
import xbmcvfs

from .subsonic import Client

ADDON_ID = "plugin.audio.resonuls"
PLUGIN_URL = "plugin://{}/".format(ADDON_ID)


def addon():
    # A fresh instance each time: Kodi hands a stale copy of the settings to
    # one kept from before they were changed.
    return xbmcaddon.Addon(ADDON_ID)


def text(string_id):
    return addon().getLocalizedString(string_id)


def log(message, level=xbmc.LOGINFO):
    xbmc.log("[{}] {}".format(ADDON_ID, message), level)


def client():
    """The configured client, or None while the server is not set up."""
    settings = addon()
    url = settings.getSettingString("server_url")
    user = settings.getSettingString("username")
    if not url or not user:
        return None
    return Client(url, user, settings.getSettingString("password"))


def navifind():
    return addon().getSettingBool("navifind")


def exclusive():
    return navifind() and addon().getSettingBool("exclusive")


def max_bitrate():
    return addon().getSettingInt("max_bitrate")


def device_id():
    """This Kodi, to the proxy's playing spot. Kept, so that the spot it took
    before a restart is still its own after."""
    folder = xbmcvfs.translatePath(addon().getAddonInfo("profile"))
    path = os.path.join(folder, "device")
    try:
        with open(path, encoding="utf-8") as stored:
            known = stored.read().strip()
        if known:
            return known
    except OSError:
        pass
    made = "kodi-" + uuid.uuid4().hex
    os.makedirs(folder, exist_ok=True)
    with open(path, "w", encoding="utf-8") as stored:
        stored.write(made)
    return made


def device_name():
    return "Kodi ({})".format(xbmc.getInfoLabel("System.FriendlyName") or "Kodi")


def show_player(wait_sec=10):
    """Kodi's full-screen music player, where OK brings pause, stop and next:
    a TV remote has no other way to it from the add-on's lists. Waits for the
    music to start and for Kodi's busy spinner to go, since the window opens
    neither on silence nor over a dialog."""
    monitor = xbmc.Monitor()
    for _ in range(max(1, int(wait_sec * 10))):
        if xbmc.Player().isPlayingAudio() and not xbmc.getCondVisibility("System.HasActiveModalDialog"):
            xbmc.executebuiltin("ActivateWindow(visualisation)")
            return True
        if monitor.waitForAbort(0.1):
            break
    return False
