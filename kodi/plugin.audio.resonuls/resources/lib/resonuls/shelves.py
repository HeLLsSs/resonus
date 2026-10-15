"""
What the tiled home shows, row by row, without Kodi: each shelf is a title
and its tiles, each tile what it shows and what OK does with it. The window
(`home.py`) only draws them.

An action is a word and its argument: `album:<id>` and `playlist:<id>` open a
list, `song:<shelf>:<index>` plays that shelf from that
tile, `folder:<query>` opens one of the add-on's screens and `run:<query>`
runs one of its commands.
"""

from concurrent.futures import ThreadPoolExecutor
import urllib.parse

from .subsonic import SubsonicError, as_list, clean_title

TILES = 20

# The colours behind the shortcut tiles: the app's green and its neighbours.
GREEN = "FF1DB954"
COLOURS = ("FF1DB954", "FF2D7DD2", "FF8E44AD", "FFE67E22", "FFC0392B", "FF16A085", "FF7F8C8D")


def tile(label, label2, art, action, kind, colour=""):
    return {"label": label, "label2": label2, "art": art, "action": action, "kind": kind, "colour": colour}


def query(**params):
    return urllib.parse.urlencode(params)


def album_tiles(client, albums):
    return [
        tile(album.get("name") or "", album.get("artist") or "", client.cover_url(album.get("coverArt"), 400), "album:" + album["id"], "album")
        for album in albums
    ]


def song_tiles(client, songs, shelf):
    return [
        tile(clean_title(song), song.get("artist") or "", client.cover_url(song.get("coverArt"), 400), "song:{}:{}".format(shelf, i), "song")
        for i, song in enumerate(songs)
    ]


def shortcuts(text, navifind, saved):
    """The first row: the add-on's screens as big buttons, the song to pick up first."""
    tiles = []
    if saved:
        song, who = saved
        label2 = "{} · {}".format(clean_title(song), who) if who else clean_title(song)
        # Its cover, like a record: it is a song to pick up, not a screen.
        tiles.append(tile(text(30010), label2, song.get("cover") or "DefaultMusicRecentlyPlayed.png", "run:" + query(action="resume"), "album"))
    entries = [
        (30009, "DefaultMusicSongs.png", "run:" + query(action="queue", source="random")),
        (30008, "DefaultMusicSearch.png", "folder:" + query(action="search")),
        (30004, "DefaultMusicArtists.png", "folder:" + query(action="artists")),
        (30013, "DefaultMusicPlaylists.png", "folder:" + query(action="playlists")),
        (30007, "DefaultMusicTop100.png", "folder:" + query(action="starred")),
    ]
    if navifind:
        entries.append((30011, "DefaultMusicVideos.png", "folder:" + query(action="youtube")))
    for i, (label, icon, action) in enumerate(entries):
        tiles.append(tile(text(label), "", icon, action, "action", COLOURS[(i + 1) % len(COLOURS)]))
    return tiles


def load(client, text, navifind):
    """Every row, fetched side by side. A row that fails is left out rather
    than taking the others with it. Returns the rows and the songs behind
    the rows of songs, which `song:` actions play."""

    def albums(kind):
        return album_tiles(client, client.album_list(kind, TILES))

    def saved():
        queue = client.play_queue() or {}
        songs = as_list(queue.get("entry"))
        current = next((s for s in songs if s.get("id") == queue.get("current")), None)
        if current is None:
            return None
        current = dict(current, cover=client.cover_url(current.get("coverArt"), 400))
        return current, queue.get("changedBy") or ""

    def playlists():
        return [
            tile(p.get("name") or "", str(p.get("songCount", "")), client.cover_url(p.get("coverArt"), 400), "playlist:" + p["id"], "album")
            for p in client.playlists()
        ]

    def youtube():
        signed_in = client.youtube_account().get("state") == "ok"
        for shelf in client.youtube_home(signed_in):
            songs = as_list(shelf.get("entry"))
            if songs:
                return shelf.get("title") or "YouTube", songs[:TILES]
        return None

    jobs = {
        "saved": saved,
        "newest": lambda: albums("newest"),
        "recent": lambda: albums("recent"),
        "frequent": lambda: albums("frequent"),
        "playlists": playlists,
        "random": lambda: albums("random"),
    }
    if navifind:
        jobs["youtube"] = youtube
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = {name: pool.submit(job) for name, job in jobs.items()}
    results = {}
    for name, future in futures.items():
        try:
            results[name] = future.result()
        except (SubsonicError, OSError):
            results[name] = None

    rows = [(text(30070), shortcuts(text, navifind, results["saved"]))]
    songs = {}
    if results.get("youtube"):
        title, found = results["youtube"]
        songs["youtube"] = found
        rows.append((title, song_tiles(client, found, "youtube")))
    for name, label in (("newest", 30001), ("recent", 30012), ("frequent", 30002), ("playlists", 30013), ("random", 30003)):
        if results.get(name):
            rows.append((text(label), results[name]))
    return rows, songs

