import tempfile
import unittest
from unittest import mock

import fake_kodi  # noqa: F401 - puts the add-on on the path
from resources.lib.resonuls.session import Playing, Session, track_id_of

PLUGIN = "plugin://plugin.audio.resonuls/"


def holder(mine, name="Téléphone"):
    return {"device": "x", "name": name, "mine": mine}


def session(exclusive=True):
    client = mock.MagicMock()
    client.playback.return_value = holder(True)
    return Session(client, "kodi-1", "Kodi (Salon)", exclusive), client


def actions(client, name):
    return [call.args[0] for call in client.playback.call_args_list if call.args] if name == "playback" else None


class SpotTest(unittest.TestCase):
    def test_takes_the_spot_when_a_track_starts(self):
        spot, client = session()
        spot.tick(0, Playing("1", 0, 200))
        client.playback.assert_called_with("claim", "kodi-1", name="Kodi (Salon)", song="")

    def test_says_it_still_plays_every_ten_seconds(self):
        spot, client = session()
        for second in range(21):
            spot.tick(second, Playing("1", second, 200))
        self.assertEqual(actions(client, "playback"), ["claim", "beat", "beat"])

    def test_names_the_device_that_took_over(self):
        spot, client = session()
        spot.tick(0, Playing("1", 0, 200))
        client.playback.return_value = holder(False)
        self.assertEqual(spot.tick(10, Playing("1", 10, 200)), "Téléphone")

    def test_does_not_save_its_queue_over_the_device_that_took_over(self):
        spot, client = session()
        spot.tick(0, Playing("1", 0, 200, queue=["1"]))
        client.playback.return_value = holder(False)
        spot.tick(10, Playing("1", 10, 200, queue=["1"]))
        client.save_play_queue.reset_mock()
        spot.tick(11, Playing("1", 10, 200, paused=True, queue=["1"]))
        client.save_play_queue.assert_not_called()

    def test_hands_the_spot_back_on_pause(self):
        spot, client = session()
        spot.tick(0, Playing("1", 0, 200))
        spot.tick(1, Playing("1", 1, 200, paused=True))
        self.assertEqual(actions(client, "playback")[-1], "release")

    def test_takes_it_again_when_the_proxy_forgot_it(self):
        spot, client = session()
        spot.tick(0, Playing("1", 0, 200))
        client.playback.return_value = None
        spot.tick(10, Playing("1", 10, 200))
        self.assertEqual(actions(client, "playback")[-1], "claim")

    def test_leaves_the_spot_alone_when_told_to(self):
        spot, client = session(exclusive=False)
        spot.tick(0, Playing("1", 0, 200))
        client.playback.assert_not_called()


class ListenTest(unittest.TestCase):
    def test_announces_the_track(self):
        spot, client = session()
        spot.tick(0, Playing("1", 0, 200))
        client.scrobble.assert_called_once_with("1", False)

    def test_scrobbles_halfway(self):
        spot, client = session()
        spot.tick(0, Playing("1", 0, 200))
        spot.tick(100, Playing("1", 100, 200))
        client.scrobble.assert_called_with("1", True)

    def test_scrobbles_once(self):
        spot, client = session()
        for second in (0, 100, 101):
            spot.tick(second, Playing("1", second, 200))
        self.assertEqual(client.scrobble.call_count, 2)

    def test_files_an_online_track_after_ten_seconds(self):
        spot, client = session()
        spot.tick(0, Playing("yt_a", 0))
        spot.tick(10, Playing("yt_a", 10))
        client.report_playback.assert_called_once_with("yt_a", "playing", 10000)

    def test_saves_the_queue_on_stop(self):
        spot, client = session()
        spot.tick(0, Playing("2", 5, 200, queue=["1", "2"]))
        client.save_play_queue.reset_mock()
        spot.tick(1, None)
        client.save_play_queue.assert_called_once_with(["1", "2"], "2", 5000)

    def test_the_music_goes_on_when_the_server_does_not_answer(self):
        spot, client = session()
        client.scrobble.side_effect = OSError("down")
        self.assertIsNone(spot.tick(0, Playing("1", 0, 200)))


class TrackIdTest(unittest.TestCase):
    def test_reads_the_add_ons_play_link(self):
        self.assertEqual(track_id_of(PLUGIN + "?action=play&id=42", PLUGIN, "http://music.test"), "42")

    def test_reads_the_stream_address(self):
        self.assertEqual(track_id_of("http://music.test/rest/stream.view?u=me&c=Resonuls+Kodi&id=yt_a", PLUGIN, "http://music.test"), "yt_a")

    def test_leaves_the_apps_streams_to_the_app(self):
        self.assertIsNone(track_id_of("http://music.test/rest/stream.view?u=me&c=Resonuls&id=yt_a", PLUGIN, "http://music.test"))

    def test_ignores_anything_else(self):
        self.assertIsNone(track_id_of("/music/song.flac", PLUGIN, "http://music.test"))


if __name__ == "__main__":
    unittest.main()


class ServiceTest(unittest.TestCase):
    def test_starts_and_stops_with_kodi(self):
        from resources.lib.resonuls import service

        with mock.patch.dict("os.environ", RESONULS_TEST_PROFILE=tempfile.mkdtemp()):
            self.assertIsNone(service.main())
