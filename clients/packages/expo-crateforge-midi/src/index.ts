import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

import type {
  DevicesChangedEvent,
  MidiDeviceDescriptor,
  MidiMessageEvent,
} from './ExpoCrateforgeMidi.types';

export type {
  DevicesChangedEvent,
  MidiDeviceDescriptor,
  MidiMessageEvent,
} from './ExpoCrateforgeMidi.types';

/**
 * A handle returned by the listener registrars. Call {@link Subscription.remove}
 * to stop receiving events.
 */
export type Subscription = {
  remove: () => void;
};

type CrateforgeMidiEvents = {
  onMidiMessage: (message: MidiMessageEvent) => void;
  onDevicesChanged: (payload: DevicesChangedEvent) => void;
};

type ExpoCrateforgeMidiNativeModule = {
  isSupported(): boolean;
  listDevices(): MidiDeviceDescriptor[];
  start(): void;
  stop(): void;
  addListener<EventName extends keyof CrateforgeMidiEvents>(
    eventName: EventName,
    listener: CrateforgeMidiEvents[EventName]
  ): EventSubscription;
};

/**
 * The native module, or `null` when it is unavailable.
 *
 * `requireOptionalNativeModule` returns `null` (instead of throwing) when the native
 * code is not present — e.g. on iOS (this module is Android-only for now), on web,
 * in Expo Go, or in a dev build created before this module was added. Every exported
 * function degrades to a safe no-op / empty result in that case so the DJ screen can
 * keep working with touch controls only.
 */
const NativeModule = requireOptionalNativeModule<ExpoCrateforgeMidiNativeModule>('ExpoCrateforgeMidi');

const NOOP_SUBSCRIPTION: Subscription = { remove: () => {} };

/**
 * Whether MIDI input is available in the current runtime (native module present
 * AND the device reports the android.software.midi feature).
 */
export function isAvailable(): boolean {
  if (!NativeModule) {
    return false;
  }
  try {
    return NativeModule.isSupported();
  } catch {
    return false;
  }
}

/**
 * List the currently attached MIDI devices. Empty when unavailable. Devices with
 * `outputPorts > 0` can send input to the app (that's what DJ mode listens to).
 */
export function listDevices(): MidiDeviceDescriptor[] {
  if (!NativeModule) {
    return [];
  }
  try {
    return NativeModule.listDevices();
  } catch {
    return [];
  }
}

/**
 * Start listening: opens every attached device's output ports and begins emitting
 * `onMidiMessage` events. Idempotent; hot-plugged devices are picked up automatically
 * until {@link stop} is called. Safe no-op when unavailable.
 */
export function start(): void {
  if (!NativeModule) {
    return;
  }
  try {
    NativeModule.start();
  } catch {
    // best-effort: never let a MIDI failure bubble up to the UI.
  }
}

/**
 * Stop listening and close all opened MIDI ports/devices. Safe to call multiple
 * times / when unavailable.
 */
export function stop(): void {
  if (!NativeModule) {
    return;
  }
  try {
    NativeModule.stop();
  } catch {
    // best-effort
  }
}

/** Subscribe to a native event with the shared "never throw" fallback semantics. */
function addListener<EventName extends keyof CrateforgeMidiEvents>(
  eventName: EventName,
  listener: CrateforgeMidiEvents[EventName]
): Subscription {
  if (!NativeModule) {
    return { ...NOOP_SUBSCRIPTION };
  }
  try {
    const subscription = NativeModule.addListener(eventName, listener);
    return {
      remove: () => {
        try {
          subscription.remove();
        } catch {
          // best-effort
        }
      },
    };
  } catch {
    return { ...NOOP_SUBSCRIPTION };
  }
}

/**
 * Subscribe to parsed channel-voice MIDI messages ({@link MidiMessageEvent}).
 * Only fires between {@link start} and {@link stop}.
 */
export function addMidiMessageListener(
  listener: (message: MidiMessageEvent) => void
): Subscription {
  return addListener('onMidiMessage', listener);
}

/**
 * Subscribe to device plug/unplug events. The payload carries the full current
 * device list so callers don't need a separate {@link listDevices} round-trip.
 */
export function addDevicesChangedListener(
  listener: (payload: DevicesChangedEvent) => void
): Subscription {
  return addListener('onDevicesChanged', listener);
}
