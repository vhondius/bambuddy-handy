package com.vhondius.bambuddyhandy

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

private const val LATEST_RELEASE = "https://api.github.com/repos/vhondius/bambuddy-handy/releases/latest"
private const val DOWNLOADS = "https://github.com/vhondius/bambuddy-handy/"

data class AppUpdate(val version: String, val url: String)

/** True when [tag] ("v1.2.0") is a later version than [current] ("1.1"). A tag that isn't plain numbers never is. */
fun isNewerVersion(tag: String, current: String): Boolean {
    fun parts(text: String): List<Long>? {
        val digits = Regex("""v?(\d+(?:\.\d+)*)""").matchEntire(text.trim())?.groupValues?.get(1) ?: return null
        return digits.split('.').map { it.toLongOrNull() ?: return null }
    }
    val new = parts(tag) ?: return false
    val old = parts(current) ?: return false
    for (i in 0 until maxOf(new.size, old.size)) {
        val a = new.getOrElse(i) { 0L }
        val b = old.getOrElse(i) { 0L }
        if (a != b) return a > b
    }
    return false
}

/**
 * The update in GitHub's "latest release" answer, or null when it's no newer
 * than [current]. Points at the release's APK, else at the release page, and
 * only ever at this repository, because the link gets opened.
 */
fun parseLatestRelease(json: String, current: String): AppUpdate? {
    val release = JSONObject(json)
    val tag = release.getString("tag_name")
    if (!isNewerVersion(tag, current)) return null
    val assets = release.optJSONArray("assets")
    val apk = (0 until (assets?.length() ?: 0))
        .map { assets!!.getJSONObject(it) }
        .firstOrNull { it.optString("name").endsWith(".apk") }
        ?.optString("browser_download_url")
    val url = listOfNotNull(apk, release.optString("html_url")).firstOrNull { it.startsWith(DOWNLOADS) }
        ?: return null
    return AppUpdate(tag.removePrefix("v"), url)
}

/** Asks GitHub for the latest release. Blocks, so call it off the main thread. Null on no update or any failure. */
fun fetchAppUpdate(current: String): AppUpdate? = try {
    val conn = URL(LATEST_RELEASE).openConnection() as HttpURLConnection
    conn.connectTimeout = 5000
    conn.readTimeout = 5000
    conn.setRequestProperty("Accept", "application/vnd.github+json")
    conn.setRequestProperty("User-Agent", "BambuddyHandy/$current")
    try {
        if (conn.responseCode == 200) {
            parseLatestRelease(conn.inputStream.bufferedReader().use { it.readText() }, current)
        } else {
            null
        }
    } finally {
        conn.disconnect()
    }
} catch (_: Exception) {
    // Offline, or GitHub's rate limit: try again next time the app opens.
    null
}
