package com.vhondius.bambuddyhandy

/** A printer's status as of one check. Plain data, so [diff] tests on the JVM. */
data class PrinterSnapshot(
    val name: String,
    val connected: Boolean,
    val state: String?,
    val task: String?,
    /** Faults worth a notification, as code to readable text. */
    val faults: Map<String, String>,
) {
    /**
     * An offline printer reports no state. Keep the last known one, so a print
     * that finished while it was offline still notifies when it returns.
     */
    fun after(old: PrinterSnapshot?): PrinterSnapshot =
        if (connected || old == null) this else copy(state = old.state, task = old.task, faults = old.faults)
}

enum class EventKind { FINISHED, FAILED, PAUSED, ERROR, OFFLINE }

data class StatusEvent(val kind: EventKind, val detail: String?)

val ACTIVE_STATES = setOf("PREPARE", "SLICING", "RUNNING", "PAUSE")

/**
 * What changed between two checks of one printer ([new] already through
 * [PrinterSnapshot.after]). The first sight of a printer only sets the baseline.
 *
 * Any change into FINISH or FAILED counts, not only one from an active state:
 * with the phone asleep a whole print can pass between two checks, and the
 * printer stays in that state until the next print.
 */
fun diff(old: PrinterSnapshot?, new: PrinterSnapshot): List<StatusEvent> {
    if (old == null) return emptyList()
    val events = mutableListOf<StatusEvent>()
    if (new.state != old.state) {
        when (new.state) {
            "FINISH" -> events += StatusEvent(EventKind.FINISHED, new.task)
            "FAILED" -> events += StatusEvent(EventKind.FAILED, new.task)
            "PAUSE" -> events += StatusEvent(EventKind.PAUSED, new.task)
        }
    }
    for ((code, description) in new.faults) {
        if (code !in old.faults) events += StatusEvent(EventKind.ERROR, description)
    }
    if (old.connected && !new.connected) events += StatusEvent(EventKind.OFFLINE, null)
    return events
}
