package expo.modules.apkinstall

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Handing a downloaded APK to Android's package installer.
 *
 * The app updates itself from its GitHub releases, and installing is the one
 * step JS cannot do: it needs a content:// the installer is allowed to read
 * (a file:// has thrown `FileUriExposedException` since Nougat) and the
 * "install unknown apps" toggle, which lives in the system's settings and is
 * per app.
 *
 * Nothing here installs anything by itself. `install` opens the system's own
 * installer, which shows what it is about to do and asks; the user can still
 * say no there. The permission behind it, `REQUEST_INSTALL_PACKAGES`, is
 * declared in this module's manifest and is useless until that toggle is on,
 * which is why it is never asked for until somebody presses Update.
 */
class ApkInstallModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("ApkInstall")

    /**
     * May the app install packages right now? Below Oreo the toggle is
     * device-wide rather than per app, and an app holding the permission could
     * always go ahead, so there is nothing to ask for there.
     */
    Function("canInstall") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@Function true
      runCatching { context.packageManager.canRequestPackageInstalls() }.getOrDefault(false)
    }

    /**
     * Opens the system screen with this app's "install unknown apps" toggle.
     * Falls back to the app's details screen on a device that hides the first
     * one. Returns whether anything could be opened.
     */
    Function("openInstallSettings") {
      val context = appContext.reactContext ?: return@Function false
      val ours = Uri.fromParts("package", context.packageName, null)
      val screens = buildList {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          add(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, ours))
        }
        add(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, ours))
      }
      screens.any { intent ->
        runCatching {
          intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          context.startActivity(intent)
        }.isSuccess
      }
    }

    /**
     * Opens the installer on the APK at `fileUri` (the `file://` that
     * expo-file-system hands back). Returns false if the file is not there or
     * no installer answered, which is all JS needs to know to fall back to the
     * release page.
     */
    Function("install") { fileUri: String ->
      runCatching {
        val path = requireNotNull(Uri.parse(fileUri).path)
        val apk = File(path)
        require(apk.exists()) { "no APK at $path" }
        val shared = FileProvider.getUriForFile(
          context,
          "${context.packageName}.apkprovider",
          apk,
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(shared, "application/vnd.android.package-archive")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
        true
      }.getOrDefault(false)
    }
  }
}
