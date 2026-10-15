"""
A Subsonic client that knows navifind's extras, and nothing about Kodi.

Everything here can run outside Kodi, which is how the tests drive it against
a fake server and how it can be tried against a real one from a terminal.
"""

import hashlib
import json
import random
import re
import string
import urllib.error
import urllib.parse
import urllib.request

API_VERSION = "1.16.1"
CLIENT_NAME = "Resonuls Kodi"
TIMEOUT = 20

ONLINE_PREFIXES = ("yt_", "sc_")

# The proxy marks a track it found online by suffixing its title; the add-on
# says the same thing with the source shown next to it, like the app does.
SOURCE_SUFFIX = re.compile(r"\s*\((?:YT|SC)\)\s*$")


class SubsonicError(Exception):
    """The server answered, and the answer was a refusal."""

    def __init__(self, message, code=0):
        super().__init__(message)
        self.code = code


def is_online(track_id):
    return str(track_id).startswith(ONLINE_PREFIXES)


def clean_title(song):
    """The song's title without the proxy's source suffix."""
    title = song.get("title") or ""
    return SOURCE_SUFFIX.sub("", title) if is_online(song.get("id", "")) else title


def as_list(value):
    """Subsonic JSON gives a lone object where a list has one element on some
    servers, and leaves the key out when it is empty."""
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


class Client:
    def __init__(self, server_url, user, password, opener=None):
        self.server_url = server_url.strip().rstrip("/")
        self.user = user
        self.password = password
        self._open = opener or urllib.request.urlopen

    def _auth(self, salt=None):
        salt = salt or "".join(random.choices(string.ascii_lowercase + string.digits, k=12))
        token = hashlib.md5((self.password + salt).encode("utf-8")).hexdigest()
        return [("u", self.user), ("t", token), ("s", salt), ("v", API_VERSION), ("c", CLIENT_NAME), ("f", "json")]

    @staticmethod
    def _pairs(params):
        pairs = []
        for key, value in params.items():
            if value is None:
                continue
            for item in as_list(value):
                pairs.append((key, "true" if item is True else "false" if item is False else str(item)))
        return pairs

    def url(self, view, **params):
        """An address that carries its own credentials, for Kodi's player and
        image loader, which cannot be handed anything else.

        Its salt never changes: Kodi caches a picture by its address, and a
        fresh salt each time made every cover a new picture to download and
        keep. The token is worth the password either way."""
        stable = hashlib.md5((self.server_url + self.user).encode("utf-8")).hexdigest()[:12]
        query = urllib.parse.urlencode(self._auth(stable) + self._pairs(params))
        return "{}/rest/{}.view?{}".format(self.server_url, view, query)

    def stream_url(self, track_id, max_bitrate=0):
        return self.url("stream", id=track_id, maxBitRate=max_bitrate or None)

    def cover_url(self, cover_id, size=600):
        return self.url("getCoverArt", id=cover_id, size=size) if cover_id else ""

    def get(self, view, **params):
        return self._call(view, params, post=False)

    def post(self, view, **params):
        """Parameters in the body: a long queue does not fit in an address."""
        return self._call(view, params, post=True)

    def _call(self, view, params, post):
        query = urllib.parse.urlencode(self._auth() + self._pairs(params))
        address = "{}/rest/{}.view".format(self.server_url, view)
        if post:
            request = urllib.request.Request(
                address,
                data=query.encode("ascii"),
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        else:
            request = urllib.request.Request(address + "?" + query)
        try:
            with self._open(request, timeout=TIMEOUT) as response:
                body = response.read()
        except urllib.error.HTTPError as error:
            # navifind answers a refusal with a Subsonic error in the body and
            # a 4xx status; the body is what says why.
            body = error.read()
        except OSError as error:
            # Unreachable, refused, timed out: said on screen like a refusal,
            # rather than a script error that closes the list.
            raise SubsonicError("Server unreachable: {}".format(getattr(error, "reason", error))) from error
        try:
            answer = json.loads(body.decode("utf-8"), strict=False)["subsonic-response"]
        except (ValueError, KeyError) as error:
            raise SubsonicError("Not a Subsonic server: {}".format(address)) from error
        if answer.get("status") != "ok":
            failure = answer.get("error") or {}
            raise SubsonicError(failure.get("message") or "Request failed", failure.get("code", 0))
        return answer

    # ── the library ─────────────────────────────────────────────────────────

    def ping(self):
        return self.get("ping")

    def artists(self):
        indexes = self.get("getArtists").get("artists", {}).get("index")
        return [artist for index in as_list(indexes) for artist in as_list(index.get("artist"))]

    def artist(self, artist_id):
        return self.get("getArtist", id=artist_id).get("artist", {})

    def album(self, album_id):
        return self.get("getAlbum", id=album_id).get("album", {})

    def song(self, track_id):
        return self.get("getSong", id=track_id).get("song", {})

    def album_list(self, kind, size=50, offset=0):
        answer = self.get("getAlbumList2", type=kind, size=size, offset=offset)
        return as_list(answer.get("albumList2", {}).get("album"))

    def playlists(self):
        return as_list(self.get("getPlaylists").get("playlists", {}).get("playlist"))

    def playlist(self, playlist_id):
        return self.get("getPlaylist", id=playlist_id).get("playlist", {})

    def starred(self):
        return self.get("getStarred2").get("starred2", {})

    def random_songs(self, size=50):
        return as_list(self.get("getRandomSongs", size=size).get("randomSongs", {}).get("song"))

    def similar_songs(self, song_id, count=50):
        answer = self.get("getSimilarSongs2", id=song_id, count=count)
        return as_list(answer.get("similarSongs2", {}).get("song"))

    def top_songs(self, artist_name, count=50):
        return as_list(self.get("getTopSongs", artist=artist_name, count=count).get("topSongs", {}).get("song"))

    def search(self, query, count=30):
        result = self.get("search3", query=query, artistCount=count, albumCount=count, songCount=count)
        found = result.get("searchResult3", {})
        return {key: as_list(found.get(key)) for key in ("artist", "album", "song")}

    def star(self, track_id=None, album_id=None, artist_id=None):
        self.get("star", id=track_id, albumId=album_id, artistId=artist_id)

    def unstar(self, track_id=None, album_id=None, artist_id=None):
        self.get("unstar", id=track_id, albumId=album_id, artistId=artist_id)

    # ── listening ───────────────────────────────────────────────────────────

    def scrobble(self, track_id, submission):
        self.get("scrobble", id=track_id, submission=submission)

    def report_playback(self, track_id, state, position_ms):
        """OpenSubsonic's playback report. For an online track the proxy reads
        it as "listened to for this long" and files it in the library past ten
        seconds."""
        self.get(
            "reportPlayback",
            mediaId=track_id,
            mediaType="song",
            positionMs=max(0, int(position_ms)),
            state=state,
            ignoreScrobble=True,
        )

    def play_queue(self):
        return self.get("getPlayQueue").get("playQueue")

    def save_play_queue(self, ids, current, position_ms):
        if ids:
            self.post("savePlayQueue", id=list(ids), current=current, position=max(0, int(position_ms)))

    # ── navifind ────────────────────────────────────────────────────────────
    # Every navifind answer sits under `navifind`, one level below the
    # Subsonic envelope: reading it one level higher reads nothing, quietly.

    def _navifind(self, view, key, **params):
        return (self.get("navifind/" + view, **params).get("navifind") or {}).get(key)

    def playback(self, action, device, **extra):
        """The account's playing spot: claim, beat, release or last."""
        return self._navifind("playback/" + action, "playback", device=device, **extra)

    def add_to_library(self, track_id):
        self.get("navifind/download", id=track_id)

    def youtube_home(self, personal):
        home = self._navifind("youtube/me/home" if personal else "youtube/home", "home") or {}
        return as_list(home.get("shelf"))

    def youtube_my_playlists(self, count=100):
        return as_list((self._navifind("youtube/me/playlists", "playlists", count=count) or {}).get("playlist"))

    def youtube_liked(self, count=200):
        return as_list((self._navifind("youtube/me/liked", "liked", count=count) or {}).get("entry"))

    def youtube_playlist(self, playlist_id, count=200):
        return self._navifind("youtube/playlist", "playlist", id=playlist_id, count=count) or {}

    def youtube_account(self):
        return self._navifind("youtube/account", "youtubeAccount") or {}


BROWSE_PREFIX = "VL"


def card_target(card):
    """Where a YouTube tile leads: ("song", id), ("playlist", id) or None.
    The same reading as `cardTarget` in the app's `lib/youtube.ts`."""
    if card.get("type") == "video":
        return ("song", "yt_" + card["videoId"]) if card.get("videoId") else None
    if card.get("type") not in ("playlist", "album"):
        return None
    browse = card.get("browseId") or ""
    playlist_id = card.get("playlistId") or (browse[len(BROWSE_PREFIX):] if browse.startswith(BROWSE_PREFIX) else browse)
    return ("playlist", playlist_id) if playlist_id else None
