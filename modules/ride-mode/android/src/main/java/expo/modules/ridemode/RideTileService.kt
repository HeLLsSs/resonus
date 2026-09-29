package expo.modules.ridemode

import android.content.ComponentName
import android.content.Context
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * The "Ride mode" tile in the quick settings shade: on or off with a tap,
 * the way the intercom would start and stop it. The tile shows what JS last
 * said (`setActive` on the module), since ride mode itself lives in JS; a
 * tap with JS gone starts it, like the intercom does.
 */
class RideTileService : TileService() {
  override fun onStartListening() {
    qsTile?.apply {
      state = if (RideConfig.isActive(this@RideTileService)) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
      updateTile()
    }
  }

  override fun onClick() {
    val on = !RideConfig.isActive(this)
    // Shown at once, and again when JS confirms: a tap that waits a second
    // for JS to start reads as a tap that did nothing.
    RideConfig.saveActive(this, on)
    onStartListening()
    Intercom.deliver(applicationContext, on, getString(R.string.ride_tile_label), source = "tile")
  }

  companion object {
    /** Redraws the tile from the saved state, wherever it is. */
    fun refresh(context: Context) {
      runCatching {
        requestListeningState(context, ComponentName(context, RideTileService::class.java))
      }
    }
  }
}
