"""Opens the app of plugin.audio.resonuls, which holds it, for a skin's menu
entry: a program add-on is what skins offer to pick there."""

import os

import xbmc
import xbmcaddon

plugin = xbmcaddon.Addon("plugin.audio.resonuls").getAddonInfo("path")
xbmc.executebuiltin("RunScript({})".format(os.path.join(plugin, "home.py")))
