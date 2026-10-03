package expo.modules.alarm

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** The time the alarm rings at, as `syncAlarm` hands it over (`src/lib/alarm.ts`). */
class AlarmConfigRecord : Record {
  @Field val enabled: Boolean = false
  @Field val hour: Int = 7
  @Field val minute: Int = 0
  @Field val days: List<Int> = emptyList()
}

/** The JS end of the alarm (`src/lib/alarm.ts`). */
class AlarmModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Alarm")

    // Each time JS comes up, the ring is put back from what was saved: the
    // reboot receiver may have been kept out of the manifest, and the system
    // drops an app's alarms when it is force-stopped.
    OnCreate {
      appContext.reactContext?.let { AlarmScheduler.schedule(it.applicationContext) }
    }

    /** Saves the time and days and schedules the next ring; returns when (ms epoch), or null. */
    Function("schedule") { config: AlarmConfigRecord ->
      val context = appContext.reactContext?.applicationContext ?: return@Function null
      AlarmScheduler.save(context, config.enabled, config.hour, config.minute, config.days)
      AlarmScheduler.schedule(context)?.toDouble()
    }
  }
}
