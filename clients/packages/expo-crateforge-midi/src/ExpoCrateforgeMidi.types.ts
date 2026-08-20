/**
 * A MIDI device currently attached to the phone/tablet (usually over USB OTG).
 *
 * - `id`: platform device id (stable while the device stays plugged in).
 * - `name`: human-readable name (e.g. "DJM-900NXS2", "DDJ-400").
 * - `inputPorts` / `outputPorts`: port counts as reported by Android. Ports are
 *   named from the device's perspective — an *output* port is what sends MIDI
 *   to the app, so controllers/mixers expose at least one output port.
 */
export type MidiDeviceDescriptor = {
  id: number;
  name: string;
  inputPorts: number;
  outputPorts: number;
};

/**
 * One parsed channel-voice MIDI message from a connected device.
 *
 * - `status`: full status byte incl. channel (e.g. 0xB3 = Control Change, ch 4).
 * - `data1` / `data2`: data bytes (0-127). For 1-data-byte messages
 *   (program change / channel pressure) `data2` is 0.
 */
export type MidiMessageEvent = {
  deviceId: number;
  deviceName: string;
  status: number;
  data1: number;
  data2: number;
};

/** Payload of the `onDevicesChanged` event (fired on plug/unplug). */
export type DevicesChangedEvent = {
  devices: MidiDeviceDescriptor[];
};
