package expo.modules.ridemode

import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import expo.modules.crashlog.DriveLog

/**
 * Every Bluetooth device coming or going, from the system. Only the ones
 * chosen as an intercom or a car are of interest; the rest is `Intercom`.
 * Each one goes in the road's log all the same, with what it started or
 * that it started nothing: "why did car mode come on in that car" is
 * answered there.
 *
 * The device's name needs BLUETOOTH_CONNECT from Android 12, which is asked
 * for when a device is chosen; should it have been taken away since, the
 * address still tells.
 */
class IntercomReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val connected = when (intent.action) {
      BluetoothDevice.ACTION_ACL_CONNECTED -> true
      BluetoothDevice.ACTION_ACL_DISCONNECTED -> false
      else -> return
    }
    val device = deviceOf(intent) ?: return
    val name = runCatching { device.name }.getOrNull()
    val config = RideConfig.load(context)
    val kind = config.kindOf(name, device.address)
    // The end of the address only: enough to tell two cars of the same name
    // apart, not a whole hardware address in a report that may be public.
    DriveLog.add(
      context,
      "bluetooth ${if (connected) "connected" else "disconnected"}: ${name ?: "?"} (…${device.address.takeLast(5)}) → ${
        when (kind) {
          "ride" -> "ride mode"
          "car" -> "car mode"
          else -> "nothing"
        }
      }",
    )
    if (kind == null) return
    Intercom.deliver(context.applicationContext, connected, name ?: device.address, kind = kind)
  }

  private fun deviceOf(intent: Intent): BluetoothDevice? =
    if (Build.VERSION.SDK_INT >= 33) {
      intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
    }
}
