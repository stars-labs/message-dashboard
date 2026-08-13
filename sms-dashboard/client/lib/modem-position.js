export function getModemPosition(mapping) {
  if (mapping?.usb_path) {
    return { path: mapping.usb_path, isLastKnown: false };
  }

  if (mapping?.last_usb_path) {
    return { path: mapping.last_usb_path, isLastKnown: true };
  }

  return null;
}
