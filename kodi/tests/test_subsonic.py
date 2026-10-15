import hashlib
import unittest
import urllib.error
import urllib.parse

import fake_kodi  # noqa: F401 - puts the add-on on the path
from fake_server import FakeServer
from resources.lib.resonuls.subsonic import Client, SubsonicError, card_target, clean_title


def client(answers=None):
    server = FakeServer(answers)
    return Client("http://music.test/", "me", "secret", opener=server), server


class ClientTest(unittest.TestCase):
    def test_signs_each_request_with_a_salted_token(self):
        api, server = client()
        api.ping()
        params = server.calls[0][1]
        self.assertEqual(params["t"][0], hashlib.md5(("secret" + params["s"][0]).encode()).hexdigest())

    def test_never_sends_the_password(self):
        api, server = client()
        api.ping()
        self.assertNotIn("secret", str(server.calls))

    def test_keeps_the_same_address_for_the_same_cover(self):
        api, _ = client()
        self.assertEqual(api.cover_url("al-1"), api.cover_url("al-1"))

    def test_repeats_the_key_for_each_queued_song(self):
        api, server = client()
        api.save_play_queue(["a", "b"], "b", 1500)
        self.assertEqual(server.calls[0][1]["id"], ["a", "b"])

    def test_raises_the_servers_refusal(self):
        api, _ = client({"ping": {"status": "failed", "error": {"code": 40, "message": "Wrong password"}}})
        with self.assertRaisesRegex(SubsonicError, "Wrong password"):
            api.ping()

    def test_says_when_the_server_cannot_be_reached(self):
        def refused(request, timeout):
            raise urllib.error.URLError(ConnectionRefusedError(61, "Connection refused"))

        with self.assertRaisesRegex(SubsonicError, "Server unreachable"):
            Client("http://music.test/", "me", "secret", opener=refused).ping()

    def test_reads_navifind_answers_one_level_below_the_envelope(self):
        api, _ = client({"navifind/playback/beat": {"navifind": {"playback": {"name": "phone", "mine": False}}}})
        self.assertEqual(api.playback("beat", "kodi-1")["name"], "phone")

    def test_streams_through_the_server(self):
        api, _ = client()
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(api.stream_url("yt_x", 192)).query)
        self.assertEqual((query["id"], query["maxBitRate"]), (["yt_x"], ["192"]))


class ReadingTest(unittest.TestCase):
    def test_drops_the_source_suffix_of_an_online_track(self):
        self.assertEqual(clean_title({"id": "yt_a", "title": "Maladie (YT)"}), "Maladie")

    def test_leaves_a_library_title_alone(self):
        self.assertEqual(clean_title({"id": "12", "title": "Live (YT)"}), "Live (YT)")

    def test_a_video_tile_plays_its_track(self):
        self.assertEqual(card_target({"type": "video", "videoId": "abc"}), ("song", "yt_abc"))

    def test_a_record_opens_its_playlist_rather_than_its_page(self):
        self.assertEqual(card_target({"type": "album", "browseId": "MPRE1", "playlistId": "OLAK"}), ("playlist", "OLAK"))

    def test_a_playlist_page_loses_its_prefix(self):
        self.assertEqual(card_target({"type": "playlist", "browseId": "VLPL123"}), ("playlist", "PL123"))

    def test_an_artist_tile_leads_nowhere(self):
        self.assertIsNone(card_target({"type": "artist", "browseId": "UC1"}))


if __name__ == "__main__":
    unittest.main()
