// Adapted from wavio (github.com/Joel-Mercier/wavio, MIT) for Resonus.
package expo.modules.carauto

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.Normalizer
import java.util.Locale
import java.util.concurrent.Executors

data class BrowseNode(
  val id: String,
  val title: String,
  val subtitle: String?,
  val artworkUrl: String?,
  val playable: Boolean,
  val contentStyle: String?, // "list" | "grid" | null
  val mediaType: String?, // "album" | "artist" | "playlist" | null
  val group: String?, // heading this item is drawn under, if any
  /** How far through this one already is, 0..1, for a row that resumes rather
   *  than starts. Null for everything that has no such thing. */
  val progress: Double?,
)

object BrowseTreeCache {
  private const val SNAPSHOT_FILE = "carauto_tree.json"
  const val ROOT_ID = "root"

  @Volatile private var nodes: Map<String, List<BrowseNode>> = emptyMap()
  @Volatile private var loaded: Boolean = false
  /** Which account the tree in hand belongs to, so another one's albums are
   *  never merged into it. Null for a tree pushed before this was written. */
  @Volatile private var profile: String? = null
  // The last browsable parent opened in Android Auto. It travels with a play
  // event so JS can queue the whole collection (the album, the playlist, the
  // section of Home) rather than only the track that was tapped.
  @Volatile private var lastBrowsedParent: String? = null
  // One thread, so the snapshots land on disk in the order they were pushed.
  // `setNodes` is a plain module function, which runs on the JavaScript
  // thread: the tree is parsed there, and writing it out as well, hundreds of
  // songs of JSON, is a pause in everything that thread draws.
  private val snapshotWriter = Executors.newSingleThreadExecutor()

  /**
   * Takes a tree from JS, whole or in part.
   *
   * The app pushes the lists within a second of opening and the songs inside
   * them a good while later, because filling the whole thing in is dozens of
   * requests and doing that at launch competed with the launch itself (#50).
   * The first of those two carries no album's songs at all, so taking it as
   * the whole truth emptied every album in the car until the second one
   * arrived, and wrote that emptiness over the snapshot on disk, which is what
   * Android Auto reads when it starts the service by itself. A partial push is
   * therefore laid over what is already here rather than replacing it.
   *
   * Only what belongs to the account in hand: signing into another one pushes
   * a partial tree too, and merging that would leave the car browsing the
   * albums of an account that is no longer open.
   */
  /**
   * Takes a tree pushed from JS and says which parents changed, so the caller
   * can tell the car. Empty when the push was unreadable and nothing moved.
   */
  fun setFromJson(context: Context, json: String): Set<String> {
    val incoming = parse(json) ?: return emptySet()
    // What is on disk is the last tree that had songs in it. Read it before
    // deciding what to keep, or a partial push on a cold start has nothing to
    // be laid over and the albums come back empty anyway.
    loadFromDiskIfNeeded(context)
    val sameAccount = profile == null || incoming.profile == null || profile == incoming.profile
    val keepWhatWeHave = incoming.partial && sameAccount
    nodes = if (keepWhatWeHave) nodes + incoming.nodes else incoming.nodes
    profile = incoming.profile ?: profile.takeIf { sameAccount }
    loaded = true
    val file = File(context.filesDir, SNAPSHOT_FILE)
    snapshotWriter.execute {
      runCatching {
        // Only a whole tree is worth keeping for the next time the car starts
        // the service on its own. A partial one holds no songs, and the point
        // of the snapshot is precisely the songs.
        if (!incoming.partial) file.writeText(json)
        // Nothing to lay this over, so what is on disk is another account's.
        else if (!sameAccount) file.delete()
      }
    }
    return incoming.nodes.keys
  }

  // For when JS has not pushed a tree into this process yet, which is what
  // happens when Android Auto starts the service on its own.
  fun loadFromDiskIfNeeded(context: Context) {
    if (loaded) return
    loaded = true
    runCatching {
      val file = File(context.filesDir, SNAPSHOT_FILE)
      if (file.exists()) {
        parse(file.readText())?.let {
          nodes = it.nodes
          profile = it.profile
        }
      }
    }
  }

  fun getChildren(parentId: String): List<BrowseNode> {
    val children = nodes[parentId] ?: emptyList()
    // The deepest parent that actually holds playable leaves is the collection
    // AA was browsing when a track was tapped, so that is the one worth keeping.
    if (children.any { it.playable }) lastBrowsedParent = parentId
    return children
  }

  fun lastBrowsedParent(): String? = lastBrowsedParent

  // Best effort: the id of the parent the tapped track lives in, when that
  // parent is known. Falls back to the last one browsed if the track cannot be
  // resolved from the cache, which is rare and only happens while it is warming
  // up. JS is the authority now (a track's mediaId carries its parent), so this
  // is only here for older ids that carry none.
  fun findParentOf(childId: String): String? {
    for ((pid, list) in nodes) {
      if (list.any { it.id == childId }) return pid
    }
    return lastBrowsedParent
  }

  fun debugSummary(): String {
    val root = nodes[ROOT_ID]?.size ?: 0
    // How many collections have their songs, which is the difference between a
    // wall of covers that plays and one that opens onto nothing.
    val filled = nodes.count { (_, list) -> list.any { it.playable } }
    return "root=$root totalParents=${nodes.size} withSongs=$filled"
  }

  // ── Search ──────────────────────────────────────────────────────────────────
  // What this cache can answer on its own, which is the shelves plus the songs
  // of the albums that were prefetched, and not the whole library. It is what
  // the car gets at once, and what it keeps when nothing else comes: the car
  // asks with the screen off and the phone locked, which is when React Native
  // stops running timers and its `fetch` stops resolving (#103). The rest of
  // the library is asked of JS and laid behind these (see `CarSearch`).

  /** Ceiling on what a query returns. The car pages through them anyway. */
  private const val MAX_RESULTS = 60

  /**
   * Everything in the tree matching `query`, best match first.
   *
   * The same album sits under several parents (a shelf and the library), and
   * the same song under an album and its artist, so results are deduplicated:
   * by id, and for a track by the song it points at, since its id carries the
   * parent it was found in.
   */
  fun search(query: String): List<BrowseNode> = ranked(query).take(MAX_RESULTS).map { it.first }

  /** Every node worth something for `query` with what it is worth, best
   *  first. What `search` and the spoken requests both read. */
  private fun ranked(query: String): List<Pair<BrowseNode, Int>> {
    val q = fold(query)
    if (q.isEmpty()) return emptyList()
    val tokens = q.split(' ').filter { it.isNotEmpty() }
    val seen = HashSet<String>()
    val hits = ArrayList<Pair<BrowseNode, Int>>()
    for ((_, children) in nodes) {
      for (node in children) {
        if (!seen.add(dedupeKey(node))) continue
        val score = score(node, q, tokens)
        if (score > 0) hits.add(node to score)
      }
    }
    // Sorting is stable, so nodes of equal worth stay in the order the tree
    // holds them, and a collection comes before a single track: it is the
    // shorter way to say the same thing, and one tap plays all of it.
    return hits.sortedWith(compareByDescending<Pair<BrowseNode, Int>> { it.second }.thenBy { it.first.playable })
  }

  /** The song a track id points at, or the node's own id. */
  private fun dedupeKey(node: BrowseNode): String =
    if (node.id.startsWith("track|")) node.id.substringAfter('|').substringAfter('|') else node.id

  /**
   * How well a node answers the query, 0 for not at all.
   *
   * What was typed against the title first, and only then against the line
   * under it, halved: an artist's name matching a song's subtitle exactly is
   * still worth more than an album whose title merely contains the word.
   */
  private fun score(node: BrowseNode, q: String, tokens: List<String>): Int {
    val title = score(node.title, q, tokens)
    if (title > 0) return title
    return score(node.subtitle, q, tokens) / 2
  }

  /** What a title is worth when every word said starts a word of it. Below
   *  this the match is somewhere inside the words, or under the title. */
  private const val WORD_MATCH = 60

  private fun score(text: String?, q: String, tokens: List<String>): Int {
    val t = fold(text ?: return 0)
    if (t.isEmpty()) return 0
    if (t == q) return 100
    if (t.startsWith(q)) return 80
    val words = t.split(' ')
    // "dark side" finds "The Dark Side of the Moon", and so does "moon": every
    // word typed has to start a word of the title, in any order.
    if (tokens.all { tok -> words.any { it.startsWith(tok) } }) return WORD_MATCH
    if (tokens.all { t.contains(it) }) return 40
    return 0
  }

  // Hoisted: `fold` runs on every title and every subtitle in the tree, and
  // building these inside it meant compiling two patterns a few thousand times
  // per query.
  private val MARKS = Regex("\\p{Mn}+")
  private val SPACES = Regex("\\s+")

  /** Lowercase, unaccented and single-spaced, so "Bjork" finds "Björk". */
  private fun fold(s: String): String {
    val stripped = Normalizer.normalize(s, Normalizer.Form.NFD).replace(MARKS, "")
    return stripped.lowercase(Locale.ROOT).replace(SPACES, " ").trim()
  }

  // ── Spoken requests ─────────────────────────────────────────────────────────

  /**
   * What the assistant understood of "play ...": the words themselves, and
   * when it managed to parse them, which kind of thing was asked for and the
   * names it picked out. "Play the album Abbey Road" arrives with the album
   * focus and `album` filled in; "play Abbey Road" arrives as words alone.
   */
  data class VoiceRequest(
    val query: String?,
    val focus: String? = null,
    val artist: String? = null,
    val album: String? = null,
    val title: String? = null,
    val playlist: String? = null,
    val genre: String? = null,
  )

  /** The focus values `MediaStore.EXTRA_MEDIA_FOCUS` carries, as the platform
   *  spells them. Literal, because the `Playlists` and `Genres` classes that
   *  used to hold them are deprecated and the strings are not. */
  private const val FOCUS_ARTIST = "vnd.android.cursor.item/artist"
  private const val FOCUS_ALBUM = "vnd.android.cursor.item/album"
  private const val FOCUS_SONG = "vnd.android.cursor.item/audio"
  private const val FOCUS_PLAYLIST = "vnd.android.cursor.item/playlist"
  private const val FOCUS_GENRE = "vnd.android.cursor.item/genre"

  /**
   * The one thing to start playing for a spoken request.
   *
   * A request the assistant parsed is answered in kind: an artist asked for
   * by name is looked for among the artists, an album among the albums, and
   * only failing that among everything. Words alone go to everything, where
   * a playlist, an album or an artist called what was said comes before a
   * song called the same, and an exact name before a near one: "play Abbey
   * Road" means the record, not its title track. What the tree cannot answer
   * is handed to JS as a search of the library (`search:<words>`), which is
   * a request over the network and may come back to nothing with the screen
   * off, but beats saying nothing at all.
   *
   * Only what JS knows how to resolve: a track, a mix, an album, an artist, a
   * playlist, smart or not, a genre, a past queue, a resume point or the
   * favourites. The tabs and the drawers are places to browse, not answers
   * to "play something", and offering one would start silence.
   */
  fun voicePick(request: VoiceRequest): BrowseNode? {
    val query = request.query?.trim().orEmpty()
    // "Play music", with nothing said about what. The favourites are the
    // closest thing to an answer the tree has.
    if (query.isEmpty()) return firstPlayableCollection()?.let { intoSomethingToPlay(it) }
    val hit = focusedPick(request, query) ?: namedPick(query)
    return hit?.let { intoSomethingToPlay(it) } ?: searchNode(query)
  }

  /** A request the assistant parsed, answered among the kind it named. */
  private fun focusedPick(request: VoiceRequest, query: String): BrowseNode? {
    val (text, kind) = when (request.focus) {
      FOCUS_ARTIST -> (request.artist ?: query) to { n: BrowseNode -> n.id.startsWith("artist:") }
      FOCUS_ALBUM -> (request.album ?: query) to { n: BrowseNode -> n.id.startsWith("album:") }
      FOCUS_PLAYLIST -> (request.playlist ?: query) to { n: BrowseNode -> n.isPlaylist() }
      FOCUS_GENRE -> (request.genre ?: query) to { n: BrowseNode -> n.id.startsWith("genre:") }
      FOCUS_SONG -> (request.title ?: query) to { n: BrowseNode -> n.id.startsWith("track|") }
      else -> return null
    }
    return ranked(text).firstOrNull { (node, score) -> score >= WORD_MATCH && kind(node) }?.first
  }

  /** Words alone: a collection named for them first, then the best of the rest. */
  private fun namedPick(query: String): BrowseNode? {
    val hits = ranked(query)
    return hits.firstOrNull { (node, score) -> score >= WORD_MATCH && node.isCollection() }?.first
      ?: hits.firstOrNull { (node, _) -> node.canBePlayed() }?.first
  }

  /** A leaf JS answers by searching the library for the words. */
  private fun searchNode(query: String): BrowseNode =
    BrowseNode(
      id = "search:$query",
      title = query,
      subtitle = null,
      artworkUrl = null,
      playable = true,
      contentStyle = null,
      mediaType = null,
      group = null,
      progress = null,
    )

  /**
   * An album or an artist becomes the first song the tree holds for it.
   *
   * Handed over as the collection, JS has to ask the server what is in it, and
   * a request made with the screen off never comes back. Handed a song, it
   * queues the collection from what it already has and plays, which is the
   * difference between an answer and silence. A track id carries the parent it
   * came from, so the whole album still gets queued behind it.
   */
  private fun intoSomethingToPlay(node: BrowseNode): BrowseNode =
    if (node.playable) node else nodes[node.id]?.firstOrNull { it.playable } ?: node

  private fun firstPlayableCollection(): BrowseNode? {
    for ((_, children) in nodes) {
      children.firstOrNull { it.id == "favorites" }?.let { return it }
    }
    for ((_, children) in nodes) {
      children.firstOrNull { it.canBePlayed() }?.let { return it }
    }
    return null
  }

  private fun BrowseNode.isPlaylist(): Boolean =
    id.startsWith("playlist:") || id.startsWith("smart:") || id == "favorites"

  /** A thing with songs inside it that JS can queue whole. */
  private fun BrowseNode.isCollection(): Boolean = isCollectionId(id)

  /** The same, for an id alone: what JS can fetch the songs of on request. */
  fun isCollectionId(id: String): Boolean =
    id.startsWith("album:") || id.startsWith("artist:") || id.startsWith("playlist:") ||
      id.startsWith("smart:") || id == "favorites"

  private fun BrowseNode.canBePlayed(): Boolean = playable || isCollection()

  /** A tree as it arrives: the nodes, whether it is only part of one, and the
   *  account it was built for. */
  private data class Snapshot(
    val nodes: Map<String, List<BrowseNode>>,
    val partial: Boolean,
    val profile: String?,
  )

  private fun parse(json: String): Snapshot? = try {
    val root = JSONObject(json)
    val nodesObj = root.optJSONObject("nodes") ?: return null
    val map = HashMap<String, List<BrowseNode>>(nodesObj.length())
    val keys = nodesObj.keys()
    while (keys.hasNext()) {
      val k = keys.next()
      val arr = nodesObj.optJSONArray(k) ?: continue
      map[k] = parseList(arr)
    }
    Snapshot(
      nodes = map,
      partial = root.optBoolean("partial", false),
      profile = root.optString("profile").takeIf { it.isNotEmpty() },
    )
  } catch (_: Throwable) {
    null
  }

  /**
   * A list of nodes as JS writes them, and the way back.
   *
   * The tree travels one way only, but a search does not: the car's own hits
   * are handed to JS so that it can lay the library's behind them, and what it
   * makes of the two comes back the same way (`CarSearch`).
   */
  fun nodesToJson(nodes: List<BrowseNode>): String {
    val arr = JSONArray()
    for (n in nodes) {
      arr.put(
        JSONObject()
          .put("id", n.id)
          .put("title", n.title)
          .put("subtitle", n.subtitle)
          .put("artworkUrl", n.artworkUrl)
          .put("playable", n.playable)
          .put("contentStyle", n.contentStyle)
          .put("mediaType", n.mediaType)
          .put("group", n.group)
          .put("progress", n.progress),
      )
    }
    return arr.toString()
  }

  fun parseNodes(arr: JSONArray?): List<BrowseNode> = if (arr == null) emptyList() else parseList(arr)

  private fun parseList(arr: JSONArray): List<BrowseNode> {
    val out = ArrayList<BrowseNode>(arr.length())
    for (i in 0 until arr.length()) {
      val o = arr.optJSONObject(i) ?: continue
      out.add(
        BrowseNode(
          id = o.optString("id"),
          title = o.optString("title"),
          subtitle = o.optString("subtitle").takeIf { it.isNotEmpty() },
          artworkUrl = o.optString("artworkUrl").takeIf { it.isNotEmpty() },
          playable = o.optBoolean("playable", false),
          contentStyle = o.optString("contentStyle").takeIf { it.isNotEmpty() },
          mediaType = o.optString("mediaType").takeIf { it.isNotEmpty() },
          group = o.optString("group").takeIf { it.isNotEmpty() },
          progress = if (o.isNull("progress")) null else o.optDouble("progress").takeIf { !it.isNaN() },
        )
      )
    }
    return out
  }
}
