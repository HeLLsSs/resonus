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


if __name__ == "__main__":
    unittest.main()
