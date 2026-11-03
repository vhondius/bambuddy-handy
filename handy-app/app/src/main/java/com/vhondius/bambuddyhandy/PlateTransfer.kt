package com.vhondius.bambuddyhandy

import org.json.JSONObject
import org.json.JSONTokener
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import java.util.UUID

/**
 * Gets a plate's 3MF to Bambuddy using the MakerWorld tab's own session. The
 * bytes go straight from one connection to the other, so no file ever exists
 * on the phone.
 */
internal object PlateTransfer {
    class SignedOut : Exception()
    class Link(val url: String, val name: String)

    /**
     * Run in the MakerWorld tab: the same request the site's Download makes.
     * Synchronous so evaluateJavascript hands the answer back directly, with no
     * extra native method exposed to MakerWorld's page.
     */
    fun linkRequestJs(instanceId: Long): String =
        "(function(){var x=new XMLHttpRequest();try{" +
            "x.open('GET','/api/v1/design-service/instance/$instanceId/f3mf?type=download',false);x.send();" +
            "return JSON.stringify({status:x.status,body:x.responseText})" +
            "}catch(e){return JSON.stringify({status:0,body:String(e)})}})()"

    /** [raw] is evaluateJavascript's result: the string above, JSON-quoted once more. */
    fun parseLink(raw: String?): Link {
        val answer = JSONObject(JSONTokener(raw ?: "null").nextValue() as? String ?: throw IOException("no answer"))
        val status = answer.getInt("status")
        if (status == 401 || status == 403) throw SignedOut()
        if (status != 200) throw IOException("HTTP $status")
        val manifest = JSONObject(answer.getString("body"))
        val url = manifest.optString("url")
        if (!isDownloadHost(url)) throw IOException("no usable download link")
        return Link(url, manifest.optString("name"))
    }

    /** The hosts Bambuddy itself accepts signed links from (http.py). */
    fun isDownloadHost(url: String): Boolean {
        val uri = try { URI(url) } catch (_: Exception) { return false }
        val host = uri.host?.lowercase() ?: return false
        return uri.scheme == "https" &&
            (host == "makerworld.bblmw.com" || host == "public-cdn.bblmw.com" || host.endsWith(".amazonaws.com"))
    }

    /** Percent-encoded, so a name can't break out of the multipart header. Bambuddy decodes it. */
    fun multipartHead(boundary: String, name: String): String {
        val encoded = URLEncoder.encode(name.ifEmpty { "plate.3mf" }, "UTF-8").replace("+", "%20")
        return "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"$encoded\"\r\n" +
            "Content-Type: application/octet-stream\r\n\r\n"
    }

    fun send(link: Link, uploadUrl: String, token: String, apiKey: String?) {
        val boundary = UUID.randomUUID().toString()
        val down = URL(link.url).openConnection() as HttpURLConnection
        val up = URL(uploadUrl).openConnection() as HttpURLConnection
        try {
            down.connectTimeout = TIMEOUT_MS
            down.readTimeout = TIMEOUT_MS
            down.instanceFollowRedirects = false
            if (down.responseCode != 200) throw IOException("download HTTP ${down.responseCode}")

            up.connectTimeout = TIMEOUT_MS
            up.readTimeout = TIMEOUT_MS
            up.requestMethod = "POST"
            up.doOutput = true
            up.setChunkedStreamingMode(CHUNK_BYTES)
            up.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            if (token.isNotEmpty()) up.setRequestProperty("Authorization", "Bearer $token")
            else if (apiKey != null) up.setRequestProperty("X-API-Key", apiKey)
            up.outputStream.use { out ->
                out.write(multipartHead(boundary, link.name).toByteArray())
                down.inputStream.use { it.copyTo(out, CHUNK_BYTES) }
                out.write("\r\n--$boundary--\r\n".toByteArray())
            }
            val code = up.responseCode
            if (code !in 200..299) {
                val body = up.errorStream?.use { it.readBytes().decodeToString() }.orEmpty()
                val detail = try { JSONObject(body).optString("detail") } catch (_: Exception) { "" }
                throw IOException(detail.ifEmpty { "Bambuddy HTTP $code" })
            }
        } finally {
            down.disconnect()
            up.disconnect()
        }
    }

    private const val TIMEOUT_MS = 60_000
    private const val CHUNK_BYTES = 64 * 1024
}
