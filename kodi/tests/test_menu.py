import os
import tempfile
import unittest

import fake_kodi  # noqa: F401 - puts the add-on on the path
from resources.lib.resonuls import menu

PLUGIN = "plugin://plugin.audio.resonuls/"
ENTRIES = [("Artistes", "DefaultMusicArtists.png", {"action": "artists"}), ("Rechercher", "DefaultMusicSearch.png", {"action": "search"})]


class MenuTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.kodi = os.path.join(self.root.name, "system")
        os.makedirs(self.kodi)
        with open(os.path.join(self.kodi, "artists.xml"), "w") as kodi_node:
            kodi_node.write("<node/>")
        self.profile = os.path.join(self.root.name, "profile")

    def tearDown(self):
        self.root.cleanup()

    def files(self):
        return sorted(os.listdir(self.profile))

    def test_keeps_kodis_own_entries_next_to_ours(self):
        menu.install(self.profile, self.kodi, PLUGIN, ENTRIES)
        self.assertEqual(self.files(), ["artists.xml", "resonuls-01.xml", "resonuls-02.xml"])

    def test_points_each_entry_at_its_screen(self):
        menu.install(self.profile, self.kodi, PLUGIN, ENTRIES)
        with open(os.path.join(self.profile, "resonuls-01.xml")) as node:
            self.assertIn("<path>plugin://plugin.audio.resonuls/?action=artists</path>", node.read())

    def test_drops_the_entries_a_previous_run_wrote(self):
        menu.install(self.profile, self.kodi, PLUGIN, ENTRIES)
        menu.install(self.profile, self.kodi, PLUGIN, ENTRIES[:1])
        self.assertEqual(self.files(), ["artists.xml", "resonuls-01.xml"])

    def test_leaves_kodis_menu_alone_when_turned_off(self):
        menu.install(self.profile, self.kodi, PLUGIN, [])
        self.assertFalse(os.path.exists(self.profile))


if __name__ == "__main__":
    unittest.main()
