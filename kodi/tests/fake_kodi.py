"""Just enough of Kodi's Python modules to run the add-on outside Kodi.

Imported before the add-on: it puts the fakes in `sys.modules` and the add-on
folder on the path. What Kodi was asked to show or play is kept in `shown`
and `played` for the tests to read."""

import os
import sys
import types
from unittest import mock

ROOT = os.path.join(os.path.dirname(__file__), "..", "plugin.audio.resonuls")
sys.path.insert(0, os.path.abspath(ROOT))

settings = {
    "server_url": "http://music.test",
    "username": "me",
    "password": "secret",
    "navifind": True,
    "exclusive": True,
    "max_bitrate": 0,
    "music_menu": True,
    "home_at_start": True,
}
shown = []
resolved = []
played = []
notified = []
ended = []
builtins = []


class ListItem:
    def __init__(self, label="", path="", offscreen=False):
        self.label = label
        self.path = path
        self.art = {}
        self.properties = {}
        self.menu = []
        self.tag = mock.MagicMock()

    def setArt(self, art):
        self.art = art

    def setProperty(self, key, value):
        self.properties[key] = value

    def addContextMenuItems(self, items):
        self.menu += items

    def getMusicInfoTag(self):
        return self.tag

    def setPath(self, path):
        self.path = path

    def getPath(self):
        return self.path


class PlayList:
    items = []

    def __init__(self, kind):
        pass

    def clear(self):
        PlayList.items = []

    def add(self, path, item):
        item.path = path
        PlayList.items.append(item)

    def size(self):
        return len(PlayList.items)

    def __getitem__(self, index):
        return PlayList.items[index]


class Player:
    def play(self, playlist, startpos=0):
        played.append((list(PlayList.items), startpos))

    playing = False

    def isPlayingAudio(self):
        return Player.playing


class Addon:
    def __init__(self, addon_id=None):
        pass

    def getSettingString(self, key):
        return settings[key]

    def getSettingBool(self, key):
        return settings[key]

    def getSettingInt(self, key):
        return settings[key]

    def getLocalizedString(self, string_id):
        return "#{} {{}}".format(string_id)

    def getAddonInfo(self, key):
        return os.environ.get("RESONULS_TEST_PROFILE", "/tmp")

    def openSettings(self):
        pass


class Monitor:
    def waitForAbort(self, seconds):
        return True

    def abortRequested(self):
        return True


xbmc = types.ModuleType("xbmc")
xbmc.LOGINFO, xbmc.LOGWARNING = 1, 2
xbmc.PLAYLIST_MUSIC = 0
xbmc.log = lambda message, level=1: None
xbmc.PlayList = PlayList
xbmc.Player = Player
xbmc.Monitor = Monitor
xbmc.executebuiltin = lambda command: builtins.append(command)
xbmc.getInfoLabel = lambda label: "Salon"
xbmc.getCondVisibility = lambda condition: False

xbmcgui = types.ModuleType("xbmcgui")
xbmcgui.ListItem = ListItem
xbmcgui.NOTIFICATION_ERROR = "error"
dialog = mock.MagicMock()
dialog.notification.side_effect = lambda *args, **kwargs: notified.append(args)
xbmcgui.Dialog = lambda: dialog
xbmcgui.Window = lambda window_id: mock.MagicMock(getProperty=lambda key: "")
xbmcgui.WindowXML = object
xbmcgui.ACTION_PREVIOUS_MENU, xbmcgui.ACTION_NAV_BACK, xbmcgui.ACTION_CONTEXT_MENU = 10, 92, 117

xbmcplugin = types.ModuleType("xbmcplugin")
xbmcplugin.SORT_METHOD_UNSORTED, xbmcplugin.SORT_METHOD_LABEL_IGNORE_THE = 0, 1
xbmcplugin.addDirectoryItems = lambda handle, items, total: shown.extend(items)
xbmcplugin.setContent = lambda handle, content: None
xbmcplugin.setPluginCategory = lambda handle, category: None
xbmcplugin.addSortMethod = lambda handle, method: None
xbmcplugin.endOfDirectory = lambda handle, succeeded=True: ended.append(succeeded)
xbmcplugin.setResolvedUrl = lambda handle, succeeded, item: resolved.append((succeeded, item))

xbmcaddon = types.ModuleType("xbmcaddon")
xbmcaddon.Addon = Addon

xbmcvfs = types.ModuleType("xbmcvfs")
xbmcvfs.translatePath = lambda path: path

sys.modules.update(xbmc=xbmc, xbmcgui=xbmcgui, xbmcplugin=xbmcplugin, xbmcaddon=xbmcaddon, xbmcvfs=xbmcvfs)


def reset():
    for kept in (shown, resolved, played, notified, ended, builtins):
        kept.clear()
    PlayList.items = []
    Player.playing = False
