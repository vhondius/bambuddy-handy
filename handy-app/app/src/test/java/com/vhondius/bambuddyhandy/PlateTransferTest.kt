package com.vhondius.bambuddyhandy

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PlateTransferTest {
    /** What evaluateJavascript hands back: the JS string, JSON-quoted again. */
    private fun answer(status: Int, body: String) =
        JSONObject.quote(JSONObject().put("status", status).put("body", body).toString())

    @Test fun readsTheSignedLink() {
        val link = PlateTransfer.parseLink(answer(200, """{"name":"a.3mf","url":"https://public-cdn.bblmw.com/a.3mf?sig=x"}"""))
        assertEquals("https://public-cdn.bblmw.com/a.3mf?sig=x", link.url)
        assertEquals("a.3mf", link.name)
    }

    @Test fun forbiddenMeansSignedOut() {
        assertThrows(PlateTransfer.SignedOut::class.java) { PlateTransfer.parseLink(answer(403, "{}")) }
    }

    @Test fun refusesAnEmptyOrForeignLink() {
        assertThrows(Exception::class.java) { PlateTransfer.parseLink(answer(200, """{"url":""}""")) }
        assertThrows(Exception::class.java) { PlateTransfer.parseLink(answer(200, """{"url":"https://evil.example/a"}""")) }
        assertThrows(Exception::class.java) { PlateTransfer.parseLink("null") }
    }

    @Test fun hostsMatchBambuddys() {
        assertTrue(PlateTransfer.isDownloadHost("https://s3.us-west-2.amazonaws.com/x?sig=1"))
        assertFalse(PlateTransfer.isDownloadHost("http://makerworld.bblmw.com/x"))
        assertFalse(PlateTransfer.isDownloadHost("https://makerworld.bblmw.com.evil.example/x"))
    }

    @Test fun aNameCannotBreakTheHeader() {
        val head = PlateTransfer.multipartHead("b", "装配 \"2\"\r\nX: y.3mf")
        assertEquals(4, head.split("\r\n").size - 1)
        assertTrue(head.contains("%20"))
        assertFalse(head.contains("X: y"))
    }
}
