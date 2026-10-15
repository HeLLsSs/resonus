import unittest

import fake_kodi  # noqa: F401 - puts the add-on on the path
from resources.lib.resonuls.screens import art_of, kind_of, with_query

PLUGIN = "plugin://plugin.audio.resonuls/"


def entry(query, filetype="directory"):
    return {"file": PLUGIN + "?" + query, "filetype": filetype}


class KindTest(unittest.TestCase):
    def test_an_album_opens_in_the_app(self):
        self.assertEqual(kind_of(entry("action=album&id=al1"), PLUGIN), "open")

    def test_play_all_is_run_rather_than_opened(self):
        self.assertEqual(kind_of(entry("action=queue&source=album&id=al1"), PLUGIN), "run")

    def test_a_song_plays(self):
        self.assertEqual(kind_of(entry("action=play&id=s1", "file"), PLUGIN), "song")

    def test_the_way_up_is_left_out(self):
        self.assertEqual(kind_of({"file": "..", "filetype": "directory"}, PLUGIN), "")


class ArtTest(unittest.TestCase):
    def test_a_skin_icon_is_unwrapped(self):
        self.assertEqual(art_of({"thumbnail": "image://DefaultMusicTop100.png/"}), "DefaultMusicTop100.png")

    def test_a_cover_is_left_as_it_is(self):
        cover = "image://http%3a%2f%2fmusic.test%2frest%2fgetCoverArt.view/"
        self.assertEqual(art_of({"thumbnail": cover}), cover)


class SearchTest(unittest.TestCase):
    def test_a_search_carries_what_to_search_for(self):
        self.assertEqual(with_query(PLUGIN + "?action=search", "daft punk"), PLUGIN + "?action=search&query=daft+punk")


if __name__ == "__main__":
    unittest.main()
