import tempfile
import unittest
from unittest import mock

import fake_kodi
from fake_server import FakeServer
from resources.lib.resonuls import kodi, plugin
from resources.lib.resonuls.subsonic import Client

SONG = {"id": "s1", "title": "Barrowland", "artist": "Amy", "album": "Life", "albumId": "al1", "artistId": "ar1", "duration": 236, "coverArt": "mf-s1"}
ONLINE = {"id": "yt_a", "title": "Maladie (YT)", "artist": "Mauvais djo", "source": "YouTube"}
ALBUM = {"id": "al1", "name": "Life", "artist": "Amy", "coverArt": "al-1"}
ANSWERS = {
    "getAlbumList2": {"albumList2": {"album": [ALBUM]}},
    "getArtists": {"artists": {"index": [{"artist": [{"id": "ar1", "name": "Amy"}]}]}},
    "getArtist": {"artist": {"name": "Amy", "album": [ALBUM]}},
    "getSong": {"song": ONLINE},
    "getAlbum": {"album": dict(ALBUM, song=[SONG])},
    "getPlaylists": {"playlists": {"playlist": [{"id": "p1", "name": "Road", "songCount": 1}]}},
    "getPlaylist": {"playlist": {"entry": [SONG]}},
    "getStarred2": {"starred2": {"song": [SONG]}},
    "getTopSongs": {"topSongs": {"song": [SONG]}},
    "getRandomSongs": {"randomSongs": {"song": [SONG, ONLINE]}},
    "search3": {"searchResult3": {"artist": [{"id": "ar1", "name": "Amy"}], "album": [ALBUM], "song": [SONG]}},
    "getPlayQueue": {"playQueue": {"entry": [SONG, ONLINE], "current": "yt_a", "position": 0, "changedBy": "Resonuls"}},
    "navifind/playback/last": {"navifind": {"playback": {"name": "phone", "mine": False}}},
    "navifind/youtube/account": {"navifind": {"youtubeAccount": {"state": "ok"}}},
    "navifind/youtube/me/home": {"navifind": {"home": {"shelf": [
        {"title": "Quick picks", "entry": [ONLINE]},
        {"title": "Artists", "item": [{"type": "artist", "browseId": "UC1"}]},
        {"title": "Mixes", "item": [{"type": "playlist", "title": "Mix", "browseId": "VLRD1"}]},
    ]}}},
    "navifind/youtube/me/playlists": {"navifind": {"playlists": {"playlist": [{"type": "playlist", "title": "Mine", "playlistId": "PL1"}]}}},
    "navifind/youtube/playlist": {"navifind": {"playlist": {"entry": [ONLINE]}}},
}


def run(query, answers=ANSWERS):
    fake_kodi.reset()
    server = FakeServer(answers)
    with mock.patch.object(kodi, "client", lambda: Client("http://music.test", "me", "secret", opener=server)):
        plugin.Plugin(["plugin://plugin.audio.resonuls/", "1", query]).run()
    return server


def labels():
    return [item.label for _, item, _ in fake_kodi.shown]


class ScreensTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profile = tempfile.TemporaryDirectory()
        mock.patch.dict("os.environ", RESONULS_TEST_PROFILE=cls.profile.name).start()

    def test_root_offers_youtube_behind_navifind(self):
        run("")
        self.assertIn("#30011 {}", labels())

    def test_root_hides_youtube_without_navifind(self):
        with mock.patch.dict(fake_kodi.settings, navifind=False):
            run("")
        self.assertNotIn("#30011 {}", labels())

    def test_every_screen_lists_something(self):
        for query in (
            "?action=albums&kind=newest",
            "?action=artists",
            "?action=artist&id=ar1",
            "?action=album&id=al1",
            "?action=playlists",
            "?action=playlist&id=p1",
            "?action=starred",
            "?action=songs&source=top&name=Amy",
            "?action=search&query=amy",
            "?action=youtube",
            "?action=youtube_home&personal=1",
            "?action=youtube_shelf&personal=1&shelf=Quick+picks",
            "?action=youtube_playlists",
            "?action=songs&source=youtube_playlist&id=RD1",
            "?action=songs&source=random",
            "?action=saved_queue",
            "?action=home",
        ):
            with self.subTest(query=query):
                run(query)
                self.assertTrue(fake_kodi.shown)

    def test_youtube_says_where_to_sign_in(self):
        run("?action=youtube", dict(ANSWERS, **{"navifind/youtube/account": {"navifind": {"youtubeAccount": {"state": "none"}}}}))
        self.assertEqual(fake_kodi.notified[-1][1], "#30061 me")

    def test_youtube_home_leaves_out_a_shelf_of_dead_tiles(self):
        run("?action=youtube_home&personal=1")
        self.assertEqual(labels(), ["Quick picks", "Mixes"])

    def test_an_online_track_shows_without_its_suffix(self):
        run("?action=youtube_shelf&personal=1&shelf=Quick+picks")
        self.assertEqual(labels(), ["Maladie"])

    def test_a_shelf_opens_by_its_title_whatever_the_order(self):
        run("?action=youtube_shelf&personal=1&shelf=Mixes")
        self.assertEqual(labels(), ["Mix"])

    def test_a_song_plays_from_the_stream(self):
        run("?action=play&id=s1")
        self.assertIn("/rest/stream.view?", fake_kodi.resolved[0][1].path)

    def test_a_song_opened_by_its_address_keeps_its_title(self):
        run("?action=play&id=yt_a")
        self.assertEqual(fake_kodi.resolved[0][1].label, "Maladie")

    def test_the_app_names_what_it_hands_kodi(self):
        run("?action=stream&url=http%3A%2F%2Fmusic.test%2Frest%2Fstream.view%3Fid%3D1&title=Faded&artist=Alan+Walker")
        self.assertEqual(fake_kodi.resolved[0][1].label, "Faded")

    def test_play_all_queues_the_whole_album(self):
        run("?action=queue&source=album&id=al1")
        self.assertEqual(len(fake_kodi.played[0][0]), 1)

    def test_play_all_is_a_folder_kodi_does_not_queue(self):
        run("?action=album&id=al1")
        self.assertTrue(fake_kodi.shown[0][2])

    def test_play_all_opened_from_a_list_stays_on_the_list(self):
        run("?action=queue&source=album&id=al1")
        self.assertEqual(fake_kodi.ended, [False])

    def test_home_opens_the_tiles_in_the_music_window(self):
        fake_kodi.reset()
        fake_kodi.conditions.add("Window.IsActive(music) | Window.Next(music)")
        with mock.patch.object(kodi, "client", lambda: Client("http://music.test", "me", "secret", opener=FakeServer(ANSWERS))):
            plugin.Plugin(["plugin://plugin.audio.resonuls/", "1", "?action=home"]).run()
        self.assertTrue(any(b.startswith("RunScript(") for b in fake_kodi.builtins))

    def test_home_browsed_by_a_shortcut_picker_only_lists(self):
        run("?action=home")
        self.assertEqual(fake_kodi.builtins, [])

    def test_now_playing_opens_kodis_player(self):
        fake_kodi.reset()
        fake_kodi.Player.playing = True
        with mock.patch.object(kodi, "client", lambda: Client("http://music.test", "me", "secret", opener=FakeServer(ANSWERS))):
            plugin.Plugin(["plugin://plugin.audio.resonuls/", "1", "?action=now_playing"]).run()
        self.assertEqual(fake_kodi.builtins, ["ActivateWindow(visualisation)"])

    def test_now_playing_with_nothing_on_says_so(self):
        run("?action=now_playing")
        self.assertEqual(fake_kodi.notified[-1][1], "#30075 {}")

    def test_resume_starts_on_the_song_the_other_device_was_on(self):
        run("?action=resume")
        self.assertEqual(fake_kodi.played[0][1], 1)

    def test_resume_names_the_device_it_picks_up_from(self):
        run("?action=resume")
        self.assertEqual(fake_kodi.notified[-1][1], "#30059 phone")

    def test_the_saved_queue_offers_to_resume_where_it_stopped(self):
        run("?action=saved_queue")
        self.assertEqual(labels()[0], "#30060 {}".replace("{}", "Maladie", 1))

    def test_nothing_to_resume_says_so(self):
        run("?action=resume", dict(ANSWERS, getPlayQueue={}))
        self.assertEqual(fake_kodi.notified[-1][1], "#30052 {}")

    def test_a_refusal_is_shown_rather_than_raised(self):
        run("?action=artists", {"getArtists": {"status": "failed", "error": {"message": "Wrong password"}}})
        self.assertEqual(fake_kodi.notified[-1][1], "Wrong password")


if __name__ == "__main__":
    unittest.main()
