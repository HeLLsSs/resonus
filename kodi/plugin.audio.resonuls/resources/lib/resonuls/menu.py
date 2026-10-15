"""
The add-on's sections in Kodi's own Music menu, so that Music on the home
screen opens on them rather than on an add-on three screens away.

Kodi builds that menu from one small XML file per entry ("library nodes").
It reads them from the profile once a folder for them exists there, and then
from there only: so the first time, Kodi's own entries are copied in next to
ours, or they would disappear.
"""

import os
import shutil
import urllib.parse
from xml.sax.saxutils import escape

PREFIX = "resonuls-"


def node(label, icon, path, order):
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n'
        '<node order="{}" type="folder">\n'
        "\t<label>{}</label>\n"
        "\t<icon>{}</icon>\n"
        "\t<path>{}</path>\n"
        "</node>\n"
    ).format(order, escape(label), escape(icon), escape(path))


def install(folder, kodi_folder, plugin_url, entries):
    """Writes one node per entry, before Kodi's own, and drops the ones a
    previous run wrote. `entries` are (label, icon, address parameters);
    none at all takes the add-on back out of the menu."""
    if not os.path.isdir(folder):
        if not entries:
            return
        shutil.copytree(kodi_folder, folder)
    for name in os.listdir(folder):
        if name.startswith(PREFIX):
            os.remove(os.path.join(folder, name))
    for order, (label, icon, params) in enumerate(entries, start=1):
        path = plugin_url + "?" + urllib.parse.urlencode(params)
        with open(os.path.join(folder, "{}{:02d}.xml".format(PREFIX, order)), "w", encoding="utf-8") as written:
            written.write(node(label, icon, path, order))
