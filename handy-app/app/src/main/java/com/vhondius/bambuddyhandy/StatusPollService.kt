package com.vhondius.bambuddyhandy

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Checks Bambuddy's printer status and notifies on changes. The foreground
 * service keeps the process alive; each check is woken by an alarm and holds a
 * wake lock only while it runs, so the phone sleeps in between.
 *
 * ponytail: setAndAllowWhileIdle is capped by Android at about one alarm per
 * 9-15 minutes once the phone sits still with the screen off, so a notification
 * can be that late. Hold a wake lock for the whole print for 30 s timing, at
 * roughly 3-10% battery per 8-hour print (estimate).
 */
class StatusPollService : Service() {
    private val worker = Executors.newSingleThreadExecutor()
    @Volatile private var checking = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!SettingsTab.notificationsOn(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        createChannels()
        try {
            ServiceCompat.startForeground(
                this,
                ID_WATCHING,
                watchingNotification(getString(R.string.notify_watching)),
                if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0,
            )
        } catch (_: IllegalStateException) {
            // Android refused a restart from the background. Opening the app starts it again.
            stopSelf()
            return START_NOT_STICKY
        }
        if (!checking) {
            checking = true
            val lock = (getSystemService(POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:check")
            lock.acquire(WAKE_LOCK_TIMEOUT_MS)
            worker.execute {
                try {
                    check()
                } finally {
                    checking = false
                    if (lock.isHeld) lock.release()
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        worker.shutdown()
        super.onDestroy()
    }

    private fun check() {
        val saved = loadSnapshots()
        val message = try {
            val base = SettingsTab.baseUrl(this) ?: throw IOException("no address")
            val current = fetchSnapshots(base, saved)
            for ((id, snapshot) in current) {
                diff(saved[id], snapshot).forEach { notifyEvent(id, snapshot.name, it) }
            }
            saveSnapshots(current)
            getString(R.string.notify_watching)
        } catch (e: AuthRefused) {
            getString(R.string.notify_refused)
        } catch (e: IOException) {
            // Away from home with no VPN: keep trying quietly and keep the state.
            getString(R.string.notify_unreachable)
        } catch (e: org.json.JSONException) {
            getString(R.string.notify_unreachable)
        }
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
            .notify(ID_WATCHING, watchingNotification(message))
        scheduleNext(this, loadSnapshots().values.any { it.state in ACTIVE_STATES })
    }

    private fun fetchSnapshots(base: String, saved: Map<Int, PrinterSnapshot>): Map<Int, PrinterSnapshot> {
        val printers = JSONArray(get("$base/api/v1/printers/"))
        val out = LinkedHashMap<Int, PrinterSnapshot>()
        for (i in 0 until printers.length()) {
            val printer = printers.getJSONObject(i)
            val id = printer.getInt("id")
            val status = JSONObject(get("$base/api/v1/printers/$id/status"))
            val faults = LinkedHashMap<String, String>()
            val errors = status.optJSONArray("hms_errors") ?: JSONArray()
            for (e in 0 until errors.length()) {
                val error = errors.getJSONObject(e)
                val description = error.optString("description").takeUnless { error.isNull("description") || it.isEmpty() }
                if (error.optInt("severity") in 1..2 && description != null) {
                    faults[error.optString("full_code").ifEmpty { error.optString("code") }] = description
                }
            }
            out[id] = PrinterSnapshot(
                name = printer.optString("name", "#$id"),
                connected = status.optBoolean("connected"),
                state = status.optString("state").takeUnless { status.isNull("state") || it.isEmpty() },
                task = status.optString("subtask_name").takeUnless { status.isNull("subtask_name") || it.isEmpty() },
                faults = faults,
            ).after(saved[id])
        }
        return out
    }

    private fun get(url: String): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 5000
        conn.readTimeout = 10000
        SettingsTab.apiKey(this)?.let { conn.setRequestProperty("X-API-Key", it) }
        try {
            when (val code = conn.responseCode) {
                200 -> return conn.inputStream.bufferedReader().use { it.readText() }
                401, 403 -> throw AuthRefused()
                else -> throw IOException("HTTP $code")
            }
        } finally {
            conn.disconnect()
        }
    }

    private class AuthRefused : IOException()

    private fun loadSnapshots(): Map<Int, PrinterSnapshot> {
        val raw = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SNAPSHOTS, null) ?: return emptyMap()
        val json = JSONObject(raw)
        return json.keys().asSequence().associate { key ->
            val o = json.getJSONObject(key)
            val faults = o.getJSONObject("faults")
            key.toInt() to PrinterSnapshot(
                name = o.getString("name"),
                connected = o.getBoolean("connected"),
                state = o.optString("state").ifEmpty { null },
                task = o.optString("task").ifEmpty { null },
                faults = faults.keys().asSequence().associateWith { faults.getString(it) },
            )
        }
    }

    private fun saveSnapshots(snapshots: Map<Int, PrinterSnapshot>) {
        val json = JSONObject()
        for ((id, s) in snapshots) {
            json.put(
                id.toString(),
                JSONObject()
                    .put("name", s.name)
                    .put("connected", s.connected)
                    .put("state", s.state ?: "")
                    .put("task", s.task ?: "")
                    .put("faults", JSONObject(s.faults)),
            )
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SNAPSHOTS, json.toString()).apply()
    }

    private fun notifyEvent(printerId: Int, printerName: String, event: StatusEvent) {
        val title = when (event.kind) {
            EventKind.FINISHED -> R.string.notify_finished
            EventKind.FAILED -> R.string.notify_failed
            EventKind.PAUSED -> R.string.notify_paused
            EventKind.ERROR -> R.string.notify_error
            EventKind.OFFLINE -> R.string.notify_offline
        }
        val notification = NotificationCompat.Builder(this, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(title, printerName))
            .setContentText(event.detail)
            .setStyle(NotificationCompat.BigTextStyle().bigText(event.detail))
            .setContentIntent(openPrinterTab())
            .setAutoCancel(true)
            .build()
        // One per printer and kind, each error its own: a repeat replaces the last.
        val tag = "$printerId:${event.kind}:${if (event.kind == EventKind.ERROR) event.detail else ""}"
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(tag, 0, notification)
    }

    private fun watchingNotification(text: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_WATCHING)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setContentIntent(openPrinterTab())
            .setOngoing(true)
            .setSilent(true)
            .build()

    private fun openPrinterTab(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_OPEN_PRINTER, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun createChannels() {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_WATCHING, getString(R.string.channel_watching), NotificationManager.IMPORTANCE_MIN),
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ALERTS, getString(R.string.channel_alerts), NotificationManager.IMPORTANCE_HIGH),
        )
    }

    /** Wakes the service for a check, and restarts it after a reboot. */
    class Trigger : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (!SettingsTab.notificationsOn(context)) return
            // The alarm's own wake lock ends with this method: bridge the gap
            // until the service takes its own.
            (context.getSystemService(POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "${context.packageName}:trigger")
                .acquire(BRIDGE_WAKE_LOCK_MS)
            start(context)
        }
    }

    companion object {
        private const val ID_WATCHING = 1
        private const val CHANNEL_WATCHING = "watching"
        private const val CHANNEL_ALERTS = "alerts"
        private const val PREFS = "status_poll"
        private const val KEY_SNAPSHOTS = "snapshots"
        private const val CHECK_INTERVAL_MS = 60_000L
        private const val WAKE_LOCK_TIMEOUT_MS = 60_000L
        private const val BRIDGE_WAKE_LOCK_MS = 5_000L

        fun start(context: Context) {
            try {
                context.startForegroundService(Intent(context, StatusPollService::class.java))
            } catch (_: IllegalStateException) {
                // Android refused a start from the background (the process had
                // died). Opening the app starts it again.
            }
        }

        fun stop(context: Context) {
            (context.getSystemService(ALARM_SERVICE) as AlarmManager).cancel(alarm(context))
            context.stopService(Intent(context, StatusPollService::class.java))
        }

        /** During a print the alarm wakes the phone; otherwise the next check waits until it's awake anyway. */
        private fun scheduleNext(context: Context, printing: Boolean) {
            if (!SettingsTab.notificationsOn(context)) return
            val manager = context.getSystemService(ALARM_SERVICE) as AlarmManager
            val at = SystemClock.elapsedRealtime() + CHECK_INTERVAL_MS
            if (printing) {
                manager.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, alarm(context))
            } else {
                manager.set(AlarmManager.ELAPSED_REALTIME, at, alarm(context))
            }
        }

        private fun alarm(context: Context): PendingIntent = PendingIntent.getBroadcast(
            context,
            0,
            Intent(context, Trigger::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }
}
