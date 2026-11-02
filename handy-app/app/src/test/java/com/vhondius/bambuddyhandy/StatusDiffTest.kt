package com.vhondius.bambuddyhandy

import org.junit.Assert.assertEquals
import org.junit.Test

class StatusDiffTest {
    private fun snapshot(
        state: String? = "RUNNING",
        connected: Boolean = true,
        faults: Map<String, String> = emptyMap(),
    ) = PrinterSnapshot("X1", connected, state, "Benchy", faults)

    private fun kinds(old: PrinterSnapshot?, new: PrinterSnapshot) =
        diff(old, new.after(old)).map { it.kind }

    @Test fun firstSightOnlySetsTheBaseline() {
        assertEquals(emptyList<EventKind>(), kinds(null, snapshot("FINISH", faults = mapOf("a" to "Jam"))))
    }

    @Test fun printEndingAndPausingNotifyOnce() {
        assertEquals(listOf(EventKind.FINISHED), kinds(snapshot(), snapshot("FINISH")))
        assertEquals(listOf(EventKind.FAILED), kinds(snapshot(), snapshot("FAILED")))
        assertEquals(listOf(EventKind.PAUSED), kinds(snapshot(), snapshot("PAUSE")))
        assertEquals(emptyList<EventKind>(), kinds(snapshot("FINISH"), snapshot("FINISH")))
        assertEquals(emptyList<EventKind>(), kinds(snapshot("PAUSE"), snapshot("PAUSE")))
    }

    @Test fun printThatPassedWhileThePhoneSleptStillNotifies() {
        assertEquals(listOf(EventKind.FINISHED), kinds(snapshot("IDLE"), snapshot("FINISH")))
    }

    @Test fun startingOrResumingIsQuiet() {
        assertEquals(emptyList<EventKind>(), kinds(snapshot("IDLE"), snapshot("RUNNING")))
        assertEquals(emptyList<EventKind>(), kinds(snapshot("PAUSE"), snapshot("RUNNING")))
    }

    @Test fun onlyNewFaultsNotify() {
        val jam = mapOf("a" to "Jam")
        assertEquals(listOf(StatusEvent(EventKind.ERROR, "Jam")), diff(snapshot(), snapshot(faults = jam)))
        assertEquals(emptyList<EventKind>(), kinds(snapshot(faults = jam), snapshot(faults = jam)))
        assertEquals(
            listOf(StatusEvent(EventKind.ERROR, "Door")),
            diff(snapshot(faults = jam), snapshot(faults = jam + ("b" to "Door"))),
        )
    }

    @Test fun goingOfflineNotifiesOnceAndKeepsTheState() {
        val running = snapshot()
        val offline = snapshot(state = null, connected = false).after(running)
        assertEquals("RUNNING", offline.state)
        assertEquals(listOf(StatusEvent(EventKind.OFFLINE, null)), diff(running, offline))
        assertEquals(emptyList<EventKind>(), kinds(offline, snapshot(state = null, connected = false)))
    }

    @Test fun printThatFinishedWhileOfflineNotifiesOnReturn() {
        val offline = snapshot(state = null, connected = false).after(snapshot())
        assertEquals(listOf(EventKind.FINISHED), kinds(offline, snapshot("FINISH")))
    }
}
