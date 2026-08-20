package expo.modules.crateforgemidi

import android.content.Context
import android.content.pm.PackageManager
import android.media.midi.MidiDevice
import android.media.midi.MidiDeviceInfo
import android.media.midi.MidiManager
import android.media.midi.MidiOutputPort
import android.media.midi.MidiReceiver
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Receives MIDI input from controllers/mixers connected over USB (OTG) — e.g. a generic
 * MIDI controller or a Pioneer DJM mixer — via the platform [MidiManager].
 *
 * On [start] the module opens every attached MIDI device's *output* ports (device → app
 * direction) and connects a receiver that parses the raw byte stream into channel-voice
 * messages. Each parsed message is surfaced to JS as an `onMidiMessage` event with the
 * status byte (incl. channel) and data bytes; hot-plug is surfaced as `onDevicesChanged`.
 *
 * All native failures are swallowed (best-effort) so the JS layer can degrade to
 * touch-only DJ controls instead of crashing. Bluetooth MIDI is out of scope (USB only).
 */
class ExpoCrateforgeMidiModule : Module() {
  private val context: Context?
    get() = appContext.reactContext

  private val handler = Handler(Looper.getMainLooper())
  private val lock = Any()

  private var midiManager: MidiManager? = null
  private var started = false
  private var deviceCallback: MidiManager.DeviceCallback? = null

  /** Opened device + the output ports we connected receivers to (for cleanup). */
  private class OpenedDevice(
    val device: MidiDevice,
    val ports: MutableList<Pair<MidiOutputPort, MidiReceiver>> = mutableListOf(),
  )

  private val openedDevices = HashMap<Int, OpenedDevice>()

  override fun definition() = ModuleDefinition {
    Name("ExpoCrateforgeMidi")

    Events("onMidiMessage", "onDevicesChanged")

    /** Whether this device supports MIDI at all (android.software.midi feature). */
    Function("isSupported") {
      isSupported()
    }

    /** Currently attached MIDI devices (may be non-empty even before start()). */
    Function("listDevices") {
      listDevices()
    }

    Function("start") {
      start()
    }

    Function("stop") {
      stop()
    }

    OnDestroy {
      stop()
    }
  }

  private fun isSupported(): Boolean {
    val ctx = context ?: return false
    return try {
      ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_MIDI)
    } catch (_: Throwable) {
      false
    }
  }

  private fun manager(): MidiManager? {
    midiManager?.let { return it }
    if (!isSupported()) return null
    val m = try {
      context?.getSystemService(Context.MIDI_SERVICE) as? MidiManager
    } catch (_: Throwable) {
      null
    }
    midiManager = m
    return m
  }

  private fun listDevices(): List<Map<String, Any>> {
    val manager = manager() ?: return emptyList()
    return try {
      @Suppress("DEPRECATION")
      manager.devices.map { info ->
        mapOf(
          "id" to info.id,
          "name" to deviceName(info),
          "inputPorts" to info.inputPortCount,
          "outputPorts" to info.outputPortCount,
        )
      }
    } catch (_: Throwable) {
      emptyList()
    }
  }

  private fun deviceName(info: MidiDeviceInfo): String {
    return try {
      val props = info.properties
      props.getString(MidiDeviceInfo.PROPERTY_NAME)
        ?: props.getString(MidiDeviceInfo.PROPERTY_PRODUCT)
        ?: props.getString(MidiDeviceInfo.PROPERTY_MANUFACTURER)
        ?: "MIDI device #${info.id}"
    } catch (_: Throwable) {
      "MIDI device #${info.id}"
    }
  }

  private fun start() {
    val manager = manager() ?: return
    synchronized(lock) {
      if (started) return
      started = true
    }

    val callback = object : MidiManager.DeviceCallback() {
      override fun onDeviceAdded(info: MidiDeviceInfo) {
        openDevice(info)
        emitDevicesChanged()
      }

      override fun onDeviceRemoved(info: MidiDeviceInfo) {
        closeDevice(info.id)
        emitDevicesChanged()
      }
    }
    deviceCallback = callback

    try {
      @Suppress("DEPRECATION")
      manager.registerDeviceCallback(callback, handler)
    } catch (_: Throwable) {
      deviceCallback = null
    }

    try {
      @Suppress("DEPRECATION")
      manager.devices.forEach { openDevice(it) }
    } catch (_: Throwable) {
    }
  }

  private fun stop() {
    synchronized(lock) {
      if (!started && openedDevices.isEmpty() && deviceCallback == null) return
      started = false
    }

    val manager = midiManager
    val callback = deviceCallback
    if (manager != null && callback != null) {
      try {
        manager.unregisterDeviceCallback(callback)
      } catch (_: Throwable) {
      }
    }
    deviceCallback = null

    val toClose: List<OpenedDevice>
    synchronized(lock) {
      toClose = openedDevices.values.toList()
      openedDevices.clear()
    }
    toClose.forEach { closeOpened(it) }
  }

  private fun openDevice(info: MidiDeviceInfo) {
    // Only devices with output ports can send MIDI *to* us (device → app direction).
    if (info.outputPortCount <= 0) return
    val manager = manager() ?: return
    synchronized(lock) {
      if (!started || openedDevices.containsKey(info.id)) return
    }
    try {
      manager.openDevice(
        info,
        { device ->
          if (device != null) onDeviceOpened(info, device)
        },
        handler,
      )
    } catch (_: Throwable) {
    }
  }

  private fun onDeviceOpened(info: MidiDeviceInfo, device: MidiDevice) {
    val opened = OpenedDevice(device)
    val name = deviceName(info)
    for (portIndex in 0 until info.outputPortCount) {
      try {
        val port = device.openOutputPort(portIndex) ?: continue
        val receiver = EventReceiver(info.id, name)
        port.connect(receiver)
        opened.ports.add(port to receiver)
      } catch (_: Throwable) {
      }
    }

    val shouldClose: Boolean
    synchronized(lock) {
      if (started && !openedDevices.containsKey(info.id)) {
        openedDevices[info.id] = opened
        shouldClose = false
      } else {
        // stop() raced us (or a duplicate open) — undo everything we just opened.
        shouldClose = true
      }
    }
    if (shouldClose) closeOpened(opened)
  }

  private fun closeDevice(deviceId: Int) {
    val opened: OpenedDevice?
    synchronized(lock) {
      opened = openedDevices.remove(deviceId)
    }
    opened?.let { closeOpened(it) }
  }

  private fun closeOpened(opened: OpenedDevice) {
    opened.ports.forEach { (port, receiver) ->
      try {
        port.disconnect(receiver)
      } catch (_: Throwable) {
      }
      try {
        port.close()
      } catch (_: Throwable) {
      }
    }
    try {
      opened.device.close()
    } catch (_: Throwable) {
    }
  }

  private fun emitDevicesChanged() {
    try {
      sendEvent("onDevicesChanged", mapOf("devices" to listDevices()))
    } catch (_: Throwable) {
    }
  }

  /** Bridges one output port's byte stream to JS events (parsing on the MIDI thread). */
  private inner class EventReceiver(
    private val deviceId: Int,
    private val deviceName: String,
  ) : MidiReceiver() {
    private val parser = MidiStreamParser { status, data1, data2 ->
      try {
        sendEvent(
          "onMidiMessage",
          mapOf(
            "deviceId" to deviceId,
            "deviceName" to deviceName,
            "status" to status,
            "data1" to data1,
            "data2" to data2,
          ),
        )
      } catch (_: Throwable) {
      }
    }

    override fun onSend(msg: ByteArray, offset: Int, count: Int, timestamp: Long) {
      try {
        parser.feed(msg, offset, count)
      } catch (_: Throwable) {
      }
    }
  }
}

/**
 * Minimal MIDI byte-stream parser: emits complete channel-voice messages (0x80..0xEF),
 * honoring running status. System real-time bytes (0xF8+) are ignored transparently,
 * SysEx and system-common messages are skipped (they cancel running status per spec).
 */
internal class MidiStreamParser(
  private val onMessage: (status: Int, data1: Int, data2: Int) -> Unit,
) {
  private var runningStatus = 0
  private var firstData = 0
  private var haveFirst = false
  private var inSysex = false

  fun feed(bytes: ByteArray, offset: Int, count: Int) {
    for (i in offset until offset + count) {
      val b = bytes[i].toInt() and 0xFF
      when {
        // System real-time (F8..FF): may appear anywhere; never affects running status.
        b >= 0xF8 -> {}
        b == 0xF7 -> inSysex = false
        b == 0xF0 -> {
          inSysex = true
          runningStatus = 0
          haveFirst = false
        }
        // System common (F1..F6): cancels running status; data bytes fall out as strays.
        b >= 0xF0 -> {
          inSysex = false
          runningStatus = 0
          haveFirst = false
        }
        inSysex -> {}
        // New channel-voice status byte.
        b >= 0x80 -> {
          runningStatus = b
          haveFirst = false
        }
        // Data byte.
        else -> {
          val status = runningStatus
          if (status == 0) continue // stray data (e.g. after system common) — drop
          val type = status and 0xF0
          if (type == 0xC0 || type == 0xD0) {
            // Program change / channel pressure carry a single data byte.
            onMessage(status, b, 0)
          } else if (!haveFirst) {
            firstData = b
            haveFirst = true
          } else {
            haveFirst = false
            onMessage(status, firstData, b)
          }
        }
      }
    }
  }
}
