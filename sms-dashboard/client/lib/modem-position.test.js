import { describe, expect, test } from 'bun:test';
import { getModemPosition } from './modem-position.js';

describe('getModemPosition', () => {
  test('prefers the currently enumerated USB path', () => {
    expect(getModemPosition({
      usb_path: '1-1.3.2.2.3',
      last_usb_path: '1-1.4.2.2.3'
    })).toEqual({ path: '1-1.3.2.2.3', isLastKnown: false });
  });

  test('shows the last known path when a modem is offline', () => {
    expect(getModemPosition({
      usb_path: null,
      last_usb_path: '1-1.3.3.3.4'
    })).toEqual({ path: '1-1.3.3.3.4', isLastKnown: true });
  });

  test('never substitutes an IMEI suffix for a physical location', () => {
    expect(getModemPosition({
      equipment_id: '865827078904976',
      usb_path: null,
      last_usb_path: null
    })).toBeNull();
  });
});
