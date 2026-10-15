"""
What the app does with an entry of one of the add-on's lists, as Kodi's
JSON-RPC lists it, without Kodi: the app shows the add-on's screens in
windows of its own rather than in Kodi's music window, which could take the
remote elsewhere at any time.
"""

import urllib.parse

# Folders of the add-on that do something rather than list: they are run.
COMMANDS = ("queue", "resume", "now_playing", "star", "unstar", "library")


def action_of(path):
    return urllib.parse.parse_qs(urllib.parse.urlsplit(path).query).get("action", [""])[0]


def kind_of(entry, plugin_url):
    """"open" for a list to show, "run" for a command, "song" for a song
    and "" for anything else (the way up)."""
    path = entry.get("file") or ""
    if not path.startswith(plugin_url):
        return ""
    action = action_of(path)
    if action == "play":
        return "song"
    if action in COMMANDS:
        return "run"
    return "open" if entry.get("filetype") == "directory" else ""


def with_query(path, query):
    """A search's address with what to search for, so that the add-on does
    not ask for it again."""
    parts = urllib.parse.urlsplit(path)
    params = dict(urllib.parse.parse_qsl(parts.query))
    params["query"] = query
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(params)))
