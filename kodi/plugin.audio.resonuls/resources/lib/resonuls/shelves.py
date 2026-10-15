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

from .subsonic import SubsonicError, as_list, card_target, clean_title

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
        (30074, "DefaultMusicRecentlyPlayed.png", "run:" + query(action="now_playing")),
        (30009, "DefaultMusicSongs.png", "run:" + query(action="queue", source="random")),
        (30008, "DefaultMusicSearch.png", "folder:" + query(action="search")),
        (30004, "DefaultMusicArtists.png", "folder:" + query(action="artists")),
        (30013, "DefaultMusicPlaylists.png", "folder:" + query(action="playlists")),
        (30007, "DefaultMusicTop100.png", "folder:" + query(action="starred")),
    ]
    if navifind:
        entries.append((30011, "DefaultMusicVideos.png", "youtube:"))
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


# The YouTube screen's rows: its shortcuts, then this many of the home
# page's shelves, as many as the window has rows for.
YOUTUBE_SHELVES = 6
DICE_ICON = "resonuls-dice.png"


def youtube_rows(client, text):
    """The YouTube screen, laid out like the app's YouTube tab: the die and
    the account's own lists first, then each shelf of the YouTube home page
    as a row. Returns the rows and the songs behind each row, which `song:`
    actions play: a video card is a song like the others."""
    try:
        signed_in = client.youtube_account().get("state") == "ok"
    except (SubsonicError, OSError):
        signed_in = False
    shortcuts_row = [tile(text(30077), text(30078), DICE_ICON, "run:" + query(action="queue", source="youtube_mix", shuffle=1), "action", GREEN)]
    if signed_in:
        shortcuts_row += [
            tile(text(30021), "", "DefaultMusicPlaylists.png", "folder:" + query(action="youtube_playlists"), "action", COLOURS[1]),
            tile(text(30022), "", "DefaultMusicTop100.png", "folder:" + query(action="songs", source="youtube_liked"), "action", COLOURS[2]),
        ]
    rows = [(text(30070), shortcuts_row)]
    songs = {}
    try:
        shelves = client.youtube_home(signed_in)
    except (SubsonicError, OSError):
        shelves = []
    for shelf in shelves:
        if len(rows) > YOUTUBE_SHELVES:
            break
        key = "yt{}".format(len(rows))
        shelf_songs, tiles = [], []
        for song in as_list(shelf.get("entry"))[:TILES]:
            tiles.append(tile(clean_title(song), song.get("artist") or "", client.cover_url(song.get("coverArt"), 400), "song:{}:{}".format(key, len(shelf_songs)), "song"))
            shelf_songs.append(song)
        for card in as_list(shelf.get("item"))[:TILES]:
            target = card_target(card)
            if target is None:
                continue
            kind, target_id = target
            title, subtitle, thumb = card.get("title") or "", card.get("subtitle") or "", card.get("thumbnail") or ""
            if kind == "song":
                tiles.append(tile(title, subtitle, thumb, "song:{}:{}".format(key, len(shelf_songs)), "song"))
                shelf_songs.append({"id": target_id, "title": title, "artist": subtitle, "coverArt": target_id})
            else:
                tiles.append(tile(title, subtitle, thumb, "folder:" + query(action="songs", source="youtube_playlist", id=target_id), "album"))
        if tiles:
            rows.append((shelf.get("title") or "YouTube", tiles))
            songs[key] = shelf_songs
    return rows, songs
