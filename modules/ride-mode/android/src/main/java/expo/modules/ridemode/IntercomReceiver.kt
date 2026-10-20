package expo.modules.ridemode

import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * Every Bluetooth device coming or going, from the system. Only the ones
 * chosen as an intercom or a car are of interest; the rest is `Intercom`.
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
    val config = RideConfig.load(context)
    if (config.intercoms.isEmpty() && config.cars.isEmpty()) return
    val device = deviceOf(intent) ?: return
    val name = runCatching { device.name }.getOrNull()
    val kind = config.kindOf(name, device.address) ?: return
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
