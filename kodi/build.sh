#!/bin/sh
# Builds the Kodi repository the add-ons install and update from, in
# dist/pages/kodi: addons.xml and its checksum, and under each add-on's id its zip,
# the zip's sha256 and its icon. repository.resonuls.zip at the top is the one
# zip to install by hand, from Add-ons › Install from zip file, and the page
# listing it is what Kodi browses to find it.
#
#   ./build.sh            builds it
#   ./build.sh publish    builds it and puts it on the app repository's
#                         GitHub Pages, where Kodi looks
#                         (https://hellsss.github.io/resonus/kodi/)
#   REPO_URL=http://host:port/ ./build.sh   for another address, to try a
#                         release on a test Kodi first
set -eu
cd "$(dirname "$0")"
pages=dist/pages
out=$pages/kodi
url=https://hellsss.github.io/resonus/kodi/
version=$(sed -n 's/.*<addon id="plugin.audio.resonuls" name="[^"]*" version="\([^"]*\)".*/\1/p' plugin.audio.resonuls/addon.xml)

if [ "${1:-}" = publish ]; then
  # Kodi only installs a version higher than the one it has.
  if curl -fsS "${url}addons.xml" 2>/dev/null | grep -q "id=\"plugin.audio.resonuls\" name=\"[^\"]*\" version=\"$version\""; then
    echo "Version $version is already published: raise it in plugin.audio.resonuls/addon.xml first." >&2
    exit 1
  fi
fi

python3 -I - "$out" "${REPO_URL:-}" plugin.audio.resonuls repository.resonuls <<'PY'
import hashlib, os, re, shutil, sys, zipfile

out, repo_url, ids = sys.argv[1], sys.argv[2], sys.argv[3:]
DEFAULT_URL = "https://hellsss.github.io/resonus/kodi/"
SKIP = ("__pycache__", ".DS_Store")

shutil.rmtree(os.path.dirname(out), ignore_errors=True)
os.makedirs(out)
entries = []
for addon_id in ids:
    xml = open(os.path.join(addon_id, "addon.xml"), encoding="utf-8").read()
    if repo_url:
        xml = xml.replace(DEFAULT_URL, repo_url.rstrip("/") + "/")
    version = re.search(r'<addon id="[^"]+" name="[^"]+" version="([^"]+)"', xml).group(1)
    folder = os.path.join(out, addon_id)
    os.makedirs(folder)
    path = os.path.join(folder, "{}-{}.zip".format(addon_id, version))
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for root, dirs, files in os.walk(addon_id):
            dirs[:] = sorted(d for d in dirs if d not in SKIP)
            for name in sorted(files):
                if name in SKIP or name.endswith(".pyc"):
                    continue
                source = os.path.join(root, name)
                if source == os.path.join(addon_id, "addon.xml"):
                    archive.writestr(source, xml)
                else:
                    archive.write(source)
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    open(path + ".sha256", "w").write(digest)
    # Kodi shows each add-on's icon in the repository's listing from here.
    icon = re.search(r"<icon>([^<]+)</icon>", xml)
    if icon:
        target = os.path.join(folder, icon.group(1))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy(os.path.join(addon_id, icon.group(1)), target)
    if addon_id.startswith("repository."):
        shutil.copy(path, os.path.join(out, addon_id + ".zip"))
    entries.append(re.sub(r"^<\?xml[^>]*\?>\s*", "", xml).strip())
    print(path)

listing = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<addons>\n' + "\n".join(entries) + "\n</addons>\n"
open(os.path.join(out, "addons.xml"), "w", encoding="utf-8").write(listing)
open(os.path.join(out, "addons.xml.md5"), "w").write(hashlib.md5(listing.encode("utf-8")).hexdigest())
# What Kodi's file manager lists at the repository's address: the links of
# this page. Pages would otherwise answer 404 there.
open(os.path.join(out, "index.html"), "w").write(
    '<!doctype html><meta charset="utf-8"><title>Resonuls for Kodi</title>\n'
    '<p>Kodi: Add-ons › Install from zip file › this address › <a href="repository.resonuls.zip">repository.resonuls.zip</a></p>\n'
)
open(os.path.join(os.path.dirname(out), ".nojekyll"), "w").close()
PY

if [ "${1:-}" = publish ]; then
  # The branch holds the latest build only, as one commit: the history of
  # the add-on is on main.
  remote=$(git remote get-url origin)
  git -C "$pages" init -q -b gh-pages
  git -C "$pages" add -A
  git -C "$pages" commit -q -m "Resonuls for Kodi $version"
  git -C "$pages" push -qf "$remote" gh-pages
  echo "Published $version: Kodi installs it at its next check (when it starts, or daily)."
fi
