"""
What the service does while Kodi plays one of the add-on's tracks, without
Kodi: it is told what is playing once a second and answers with what the
service must do about it.

Three things ride on it, the same three the app does:

- the listen: "now playing" when a track starts, the scrobble once half of it
  (at most four minutes) has played, and the playback report that makes the
  proxy file an online track in the library past ten seconds;
- the account's playing spot (one account, one music): taken on play, beaten
  every ten seconds, handed back on pause or stop. A beat that comes back
  saying another device holds it means that device took over, and Kodi has
  to go quiet;
- the saved queue, which is what another device resumes from.
"""

import urllib.parse

from .subsonic import CLIENT_NAME

BEAT_EVERY = 10
SAVE_QUEUE_EVERY = 20
SCROBBLE_CAP = 240
# Online tracks arrive without a duration; one minute is a listen.
SCROBBLE_UNKNOWN = 60
LIBRARY_AFTER = 10


class Playing:
    """One second of Kodi's player, as far as the session cares."""

    def __init__(self, track_id, position, duration=0, paused=False, queue=(), title=""):
        self.track_id = track_id
        self.position = position
        self.duration = duration
        self.paused = paused
        self.queue = list(queue)
        self.title = title


class Session:
    def __init__(self, client, device, device_name, exclusive, log=lambda message: None):
        self.client = client
        self.device = device
        self.device_name = device_name
        self.exclusive = exclusive
        self.log = log
        self.current = None
        self.held = False
        # Set once another device took the spot: from then on that device's
        # queue is the one to resume, and saving ours would overwrite it.
        self.lost = False
        self.last_beat = 0
        self.last_save = 0
        self.scrobbled = False
        self.reported = False

    def tick(self, now, playing):
        """`playing` is None when Kodi plays nothing of ours. Returns the name
        of the device that took the spot over when Kodi must stop, or None."""
        previous = self.current
        self.current = playing
        if playing is None:
            if previous is not None:
                self._release()
                self._save(previous, now)
            return None

        if previous is None or previous.track_id != playing.track_id:
            self.scrobbled = self.reported = False
            self._quietly(self.client.scrobble, playing.track_id, False)
            if not playing.paused:
                self._claim(playing, now)
        elif playing.paused != previous.paused:
            if playing.paused:
                self._release()
                self._save(playing, now)
            else:
                self._claim(playing, now)

        if playing.paused:
            return None
        self._listen(playing)
        if now - self.last_save >= SAVE_QUEUE_EVERY:
            self._save(playing, now)
        if self.held and now - self.last_beat >= BEAT_EVERY:
            return self._beat(playing, now)
        return None

    def _listen(self, playing):
        threshold = min(playing.duration / 2, SCROBBLE_CAP) if playing.duration else SCROBBLE_UNKNOWN
        if not self.scrobbled and playing.position >= threshold:
            self.scrobbled = True
            self._quietly(self.client.scrobble, playing.track_id, True)
        if not self.reported and playing.track_id.startswith(("yt_", "sc_")) and playing.position >= LIBRARY_AFTER:
            self.reported = True
            self._quietly(self.client.report_playback, playing.track_id, "playing", playing.position * 1000)

    def _claim(self, playing, now):
        if not self.exclusive:
            return
        self.lost = False
        self.last_beat = now
        self.held = self._quietly(self.client.playback, "claim", self.device, name=self.device_name, song=playing.title) is not None

    def _beat(self, playing, now):
        self.last_beat = now
        holder = self._quietly(self.client.playback, "beat", self.device, song=playing.title)
        if holder is None:
            # Not an answer about anybody: the proxy has no spot for this
            # account any more (it was restarted, or the beats stopped long
            # enough for it to lapse). Take it again rather than go quiet.
            self._claim(playing, now)
            return None
        if holder.get("mine"):
            return None
        self.held = False
        self.lost = True
        return holder.get("name") or holder.get("device") or "?"

    def _release(self):
        if self.held:
            self.held = False
            self._quietly(self.client.playback, "release", self.device)

    def _save(self, playing, now):
        self.last_save = now
        if playing.queue and not self.lost:
            self._quietly(self.client.save_play_queue, playing.queue, playing.track_id, playing.position * 1000)

    def _quietly(self, call, *args, **kwargs):
        """None of this is worth interrupting the music for."""
        try:
            return call(*args, **kwargs)
        except Exception as error:  # noqa: BLE001 - logged, and the music goes on
            self.log("{} failed: {}".format(getattr(call, "__name__", call), error))
            return None


def track_id_of(path, plugin_url, server_url):
    """The track behind something in Kodi's player or playlist: the add-on's
    own play link before Kodi resolved it, the stream address after. Anything
    else (a file, another add-on, a radio, the app's own) is not ours and
    gives None."""
    if not path:
        return None
    if path.startswith(plugin_url):
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)
        return query.get("id", [None])[0] if query.get("action") == ["play"] else None
    if server_url and path.startswith(server_url.rstrip("/") + "/rest/stream"):
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)
        # Only the add-on's own streams: the app driving Kodi as an output
        # hands it addresses of its own, and counts those listens itself.
        return query.get("id", [None])[0] if query.get("c") == [CLIENT_NAME] else None
    return None
