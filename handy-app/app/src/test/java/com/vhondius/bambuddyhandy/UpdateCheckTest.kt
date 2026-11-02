package com.vhondius.bambuddyhandy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateCheckTest {
    private val release = "https://github.com/vhondius/bambuddy-handy/releases"

    private fun json(tag: String, apk: String? = "$release/download/$tag/BambuddyHandy.apk", page: String = "$release/tag/$tag") = """
        {"tag_name":"$tag","html_url":"$page","assets":[
          {"name":"notes.txt","browser_download_url":"$release/download/$tag/notes.txt"}
          ${if (apk != null) """,{"name":"BambuddyHandy.apk","browser_download_url":"$apk"}""" else ""}
        ]}
    """

    @Test fun comparesNumbersNotText() {
        assertTrue(isNewerVersion("v1.2.0", "1.1"))
        assertTrue(isNewerVersion("v1.10", "1.9"))
        assertTrue(isNewerVersion("2", "1.9.9"))
        assertFalse(isNewerVersion("v1.1.0", "1.1"))
        assertFalse(isNewerVersion("v1.0.0", "1.1"))
    }

    @Test fun tagThatIsNotPlainNumbersIsNeverNewer() {
        assertFalse(isNewerVersion("v9.0b1-daily.20261102", "1.1"))
        assertFalse(isNewerVersion("latest", "1.1"))
        assertFalse(isNewerVersion("v2.0", "dev"))
    }

    @Test fun newerReleasePointsAtItsApk() {
        assertEquals(
            AppUpdate("1.2.0", "$release/download/v1.2.0/BambuddyHandy.apk"),
            parseLatestRelease(json("v1.2.0"), "1.1"),
        )
    }

    @Test fun sameOrOlderReleaseIsNoUpdate() {
        assertNull(parseLatestRelease(json("v1.1"), "1.1"))
        assertNull(parseLatestRelease(json("v1.0.0"), "1.1"))
    }

    @Test fun releaseWithoutApkFallsBackToItsPage() {
        assertEquals(AppUpdate("1.2", "$release/tag/v1.2"), parseLatestRelease(json("v1.2", apk = null), "1.1"))
    }

    @Test fun linkOutsideThisRepositoryIsNotOffered() {
        assertEquals(
            AppUpdate("1.2", "$release/tag/v1.2"),
            parseLatestRelease(json("v1.2", apk = "https://evil.example/x.apk"), "1.1"),
        )
        assertNull(parseLatestRelease(json("v1.2", apk = "https://evil.example/x.apk", page = "https://evil.example/"), "1.1"))
    }
}
