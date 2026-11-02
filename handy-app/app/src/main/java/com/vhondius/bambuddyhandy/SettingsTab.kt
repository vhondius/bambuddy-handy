package com.vhondius.bambuddyhandy

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatDelegate
import com.google.android.material.button.MaterialButton
import com.google.android.material.button.MaterialButtonToggleGroup
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.textfield.TextInputEditText
import java.net.HttpURLConnection
import java.net.URL

/** The Settings tab: the Bambuddy address with a button that checks it answers, light/dark, and print notifications. */
class SettingsTab(
    root: View,
    private val requestNotificationPermission: () -> Unit,
    onSaved: (String) -> Unit,
) {
    private val context: Context = root.context
    private val notifications = root.findViewById<MaterialSwitch>(R.id.notifications)

    init {

        val input = root.findViewById<TextInputEditText>(R.id.base_url)
        val apiKeyInput = root.findViewById<TextInputEditText>(R.id.api_key)
        apiKeyInput.setText(apiKey(context))
        val result = root.findViewById<TextView>(R.id.result)
        input.setText(baseUrl(context))

        val theme = root.findViewById<MaterialButtonToggleGroup>(R.id.theme)
        theme.check(THEME_BUTTONS.entries.first { it.value == nightMode(context) }.key)
        theme.addOnButtonCheckedListener { _, id, checked ->
            val mode = THEME_BUTTONS[id] ?: return@addOnButtonCheckedListener
            if (!checked || mode == nightMode(context)) return@addOnButtonCheckedListener
            prefs(context).edit().putInt(KEY_THEME, mode).apply()
            // Recreates the activity in the new theme; the WebViews follow it
            // through prefers-color-scheme.
            AppCompatDelegate.setDefaultNightMode(mode)
        }

        root.findViewById<MaterialButton>(R.id.save).setOnClickListener {
            val url = normalize(input.text.toString())
            if (url == null) {
                result.setText(R.string.invalid_url)
                return@setOnClickListener
            }
            prefs(context).edit()
                .putString(KEY_BASE_URL, url)
                .putString(KEY_API_KEY, apiKeyInput.text.toString().trim())
                .apply()
            Toast.makeText(context, R.string.saved, Toast.LENGTH_SHORT).show()
            result.text = ""
            onSaved(url)
        }

        val test = root.findViewById<MaterialButton>(R.id.test)
        test.setOnClickListener {
            val url = normalize(input.text.toString())
            if (url == null) {
                result.setText(R.string.invalid_url)
                return@setOnClickListener
            }
            test.isEnabled = false
            result.setText(R.string.testing)
            Thread {
                val error = checkHealth(url)
                root.post {
                    test.isEnabled = true
                    result.text = if (error == null) {
                        context.getString(R.string.test_ok)
                    } else {
                        context.getString(R.string.test_failed, error)
                    }
                }
            }.start()
        }

        notifications.isChecked = notificationsOn(context)
        notifications.setOnCheckedChangeListener { _, checked ->
            when {
                !checked -> setNotifications(false)
                hasNotificationPermission() -> setNotifications(true)
                else -> requestNotificationPermission()
            }
        }
        root.findViewById<MaterialButton>(R.id.battery).setOnClickListener {
            try {
                context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (_: ActivityNotFoundException) {
            }
        }
    }

    /** The answer to [requestNotificationPermission]. */
    fun onNotificationPermission(granted: Boolean) {
        if (granted) {
            setNotifications(true)
        } else {
            notifications.isChecked = false
            Toast.makeText(context, R.string.notifications_denied, Toast.LENGTH_LONG).show()
        }
    }

    private fun setNotifications(on: Boolean) {
        prefs(context).edit().putBoolean(KEY_NOTIFICATIONS, on).apply()
        if (on) StatusPollService.start(context) else StatusPollService.stop(context)
    }

    private fun hasNotificationPermission() = Build.VERSION.SDK_INT < 33 ||
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Null when Bambuddy answered its health check, else what went wrong. */
    private fun checkHealth(base: String): String? = try {
        val conn = URL("$base/health").openConnection() as HttpURLConnection
        conn.connectTimeout = 5000
        conn.readTimeout = 5000
        try {
            val code = conn.responseCode
            val body = if (code == 200) conn.inputStream.bufferedReader().use { it.readText() } else ""
            if (code == 200 && body.contains("healthy")) null else "HTTP $code"
        } finally {
            conn.disconnect()
        }
    } catch (e: Exception) {
        e.message ?: e.javaClass.simpleName
    }

    companion object {
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_THEME = "theme"
        private const val KEY_API_KEY = "api_key"
        private const val KEY_NOTIFICATIONS = "notifications"
        private val THEME_BUTTONS = mapOf(
            R.id.theme_system to AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM,
            R.id.theme_light to AppCompatDelegate.MODE_NIGHT_NO,
            R.id.theme_dark to AppCompatDelegate.MODE_NIGHT_YES,
        )

        private fun prefs(context: Context) =
            context.getSharedPreferences("settings", Context.MODE_PRIVATE)

        /** The saved light/dark choice, as an [AppCompatDelegate] night mode. */
        fun nightMode(context: Context): Int =
            prefs(context).getInt(KEY_THEME, AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM)

        /** The saved Bambuddy address without a trailing slash, or null. */
        fun baseUrl(context: Context): String? = prefs(context).getString(KEY_BASE_URL, null)

        fun notificationsOn(context: Context): Boolean = prefs(context).getBoolean(KEY_NOTIFICATIONS, false)

        /** The saved Bambuddy API key, or null. */
        fun apiKey(context: Context): String? = prefs(context).getString(KEY_API_KEY, null)?.ifEmpty { null }

        /** "http(s)://host[:port][/path]" with no trailing slash, or null when it isn't one. */
        fun normalize(raw: String): String? {
            val url = raw.trim().trimEnd('/')
            val uri = Uri.parse(url)
            if (uri.scheme != "http" && uri.scheme != "https") return null
            if (uri.host.isNullOrEmpty()) return null
            return url
        }
    }
}
