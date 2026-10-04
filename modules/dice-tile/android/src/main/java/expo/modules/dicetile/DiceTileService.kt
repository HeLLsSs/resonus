package expo.modules.dicetile

import android.content.Intent
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * The "Die" tile in the quick settings shade: a tap rolls the die in its
 * default mode, the way the home-screen widget's die does. It sends the
 * intents API's own `play_random` (docs/INTENTS.md) to the app's receiver,
 * which starts JS with nothing on screen when the app is closed, so nothing
 * here knows about the music. A button rather than a switch: it has no state
 * to show.
 */
class DiceTileService : TileService() {
  override fun onStartListening() {
    qsTile?.apply {
      state = Tile.STATE_INACTIVE
      updateTile()
    }
  }

  override fun onClick() {
    // The receiver's action and extra, `Commands.ACTION_COMMAND` and
    // `EXTRA_COMMAND` in modules/intents-api. The package keeps it to this
    // app, and is what lets it reach a receiver declared in the manifest.
    sendBroadcast(
      Intent("com.hellsss.resonuls.COMMAND")
        .setPackage(packageName)
        .putExtra("command", "play_random"),
    )
  }
}
