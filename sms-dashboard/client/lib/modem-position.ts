interface ModemPosition {
  path: string;
  isLastKnown: boolean;
}

interface ModemPathMapping {
  usb_path?: string | null;
  last_usb_path?: string | null;
}

export function getModemPosition(
  mapping: ModemPathMapping | null | undefined,
): ModemPosition | null {
  if (mapping?.usb_path) {
    return { path: mapping.usb_path, isLastKnown: false };
  }

  if (mapping?.last_usb_path) {
    return { path: mapping.last_usb_path, isLastKnown: true };
  }

  return null;
}
