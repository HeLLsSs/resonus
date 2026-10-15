import unittest

import fake_kodi  # noqa: F401 - puts the add-on on the path
from fake_server import FakeServer
from resources.lib.resonuls import shelves
from resources.lib.resonuls.subsonic import Client

from test_plugin import ANSWERS


def load(answers=ANSWERS, navifind=True):
    client = Client("http://music.test", "me", "secret", opener=FakeServer(answers))
    return shelves.load(client, lambda string_id: "#{}".format(string_id), navifind)


def titles(rows):
    return [title for title, _ in rows]


class ShelvesTest(unittest.TestCase):
    def test_lays_out_the_rows_shortcuts_first(self):
        rows, _ = load()
        self.assertEqual(titles(rows), ["#30070", "Quick picks", "#30001", "#30012", "#30002", "#30013", "#30003"])

    def test_leaves_youtube_out_without_navifind(self):
        rows, _ = load(navifind=False)
        self.assertNotIn("Quick picks", titles(rows))

    def test_offers_to_pick_up_the_saved_queue_first(self):
        rows, _ = load()
        self.assertEqual(rows[0][1][0]["action"], "run:action=resume")

    def test_plays_a_youtube_tile_from_its_row(self):
        rows, songs = load()
        self.assertEqual((rows[1][1][0]["action"], songs["youtube"][0]["id"]), ("song:youtube:0", "yt_a"))

    def test_an_album_tile_opens_the_album(self):
        rows, _ = load()
        self.assertEqual(rows[2][1][0]["action"], "album:al1")

    def test_a_row_that_fails_does_not_take_the_others_with_it(self):
        rows, _ = load(dict(ANSWERS, getPlaylists={"status": "failed", "error": {"message": "nope"}}))
        self.assertNotIn("#30013", titles(rows))


class YouTubeTileTest(unittest.TestCase):
    def test_the_youtube_tile_opens_the_youtube_screen(self):
        rows, _ = load()
        self.assertIn("youtube:", [t["action"] for t in rows[0][1]])


class YouTubeRowsTest(unittest.TestCase):
    def rows(self):
        client = Client("http://music.test", "me", "secret", opener=FakeServer(ANSWERS))
        return shelves.youtube_rows(client, lambda string_id: "#{}".format(string_id))

    def test_the_die_comes_first(self):
        rows, _ = self.rows()
        self.assertEqual(rows[0][1][0]["action"], "run:action=queue&source=youtube_mix&shuffle=1")

    def test_each_shelf_is_a_row(self):
        rows, _ = self.rows()
        self.assertEqual(titles(rows), ["#30070", "Quick picks", "Mixes"])

    def test_a_song_of_a_shelf_plays_the_shelf(self):
        rows, songs = self.rows()
        self.assertEqual((rows[1][1][0]["action"], songs["yt1"][0]["id"]), ("song:yt1:0", "yt_a"))


if __name__ == "__main__":
    unittest.main()
