package expo.modules.ridemode

import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * Every Bluetooth device coming or going, from the system. Only the one
 * chosen as the intercom is of interest, and only when one has been chosen
 * at all; the rest is `Intercom`.
 *
 * The device's name needs BLUETOOTH_CONNECT from Android 12, which is asked
 * for when the intercom is chosen; should it have been taken away since, the
 * address still tells.
 */
class IntercomReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val connected = when (intent.action) {
      BluetoothDevice.ACTION_ACL_CONNECTED -> true
      BluetoothDevice.ACTION_ACL_DISCONNECTED -> false
      else -> return
    }
    val config = RideConfig.load(context)
    if (!config.autoStart) return
    val device = deviceOf(intent) ?: return
    val name = runCatching { device.name }.getOrNull()
    if (!config.matches(name, device.address)) return
    Intercom.deliver(context.applicationContext, connected, name ?: config.intercomName)
  }

  private fun deviceOf(intent: Intent): BluetoothDevice? =
    if (Build.VERSION.SDK_INT >= 33) {
      intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
    }
}
