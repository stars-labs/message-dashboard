#!/usr/bin/env bash
# Slim every Quectel EC20 modem's USB composition from the default 5 interfaces
# (DIAG/NMEA/AT/MODEM/QMI) down to AT+MODEM (3 interfaces, 2 ttyUSB ports).
#
# Why: each unused interface consumes USB endpoints + periodic bandwidth. On the
# xHCI controllers this exhausts host-controller resources (error -12) and caps how
# many modems enumerate. Slimming lets more modems fit per controller/hub.
#
# Safe by construction:
#   - skips modems already slimmed (bNumInterfaces != 5)
#   - only resets a modem if it ACCEPTED the usbcfg change (returned OK)
#   - processes in chunks with pauses to avoid a mass re-enumeration storm
#
# Run on the Orange Pi as root. Stops the daemon for the duration, restarts after.
set -u

USBCFG='AT+QCFG="usbcfg",0x2C7C,0x0125,0,0,1,1,0,0,0'   # diag=0 nmea=0 at=1 modem=1 rmnet=0
CHUNK=12          # modems per chunk
CHUNK_PAUSE=15    # seconds between chunks (let each chunk re-enumerate)
SETTLE=60         # final wait before restarting the daemon

# Resolve the daemon's bin dir (has at_debug) from the running process.
BIN=$(dirname "$(readlink -f /proc/"$(pgrep -x sms-daemon | head -1)"/exe 2>/dev/null)" 2>/dev/null)
if [ -z "$BIN" ] || [ ! -x "$BIN/at_debug" ]; then
  echo "FATAL: could not locate at_debug (BIN='$BIN')"; exit 1
fi
echo "using at_debug at $BIN/at_debug"

# Find the AT port for a USB device dir: first ttyUSB (ascending) that answers AT.
at_port_for_dev() {
  local dev="$1" tn dp
  for n in $(for t in /sys/class/tty/ttyUSB*; do
                tn=$(basename "$t"); dp=$(readlink -f "$t/device")
                case "$dp" in */"$dev"/*) echo "${tn#ttyUSB}";; esac
              done | sort -n); do
    if "$BIN/at_debug" "/dev/ttyUSB$n" "AT" 2>/dev/null | grep -q "OK"; then
      echo "/dev/ttyUSB$n"; return 0
    fi
  done
  return 1
}

echo "stopping daemon..."
systemctl stop sms-daemon; sleep 2

# Collect target modems (5-interface Quectel only).
TARGETS=()
for d in /sys/bus/usb/devices/*/; do
  [ "$(cat "$d/idVendor" 2>/dev/null)" = "2c7c" ] || continue
  [ "$(cat "$d/bNumInterfaces" 2>/dev/null)" = "5" ] || continue
  TARGETS+=("$(basename "$d")")
done
echo "found ${#TARGETS[@]} modems to slim (5-interface)"

done_count=0; skip_count=0; i=0
for dev in "${TARGETS[@]}"; do
  port=$(at_port_for_dev "$dev") || { echo "  $dev: no AT port, skip"; skip_count=$((skip_count+1)); continue; }
  resp=$("$BIN/at_debug" "$port" "$USBCFG" 2>&1)
  if echo "$resp" | grep -q "OK"; then
    "$BIN/at_debug" "$port" "AT+CFUN=1,1" >/dev/null 2>&1
    echo "  $dev ($port): slimmed + reset"
    done_count=$((done_count+1))
  else
    echo "  $dev ($port): usbcfg REJECTED, not reset"
    skip_count=$((skip_count+1))
  fi
  i=$((i+1))
  if [ $((i % CHUNK)) -eq 0 ]; then echo "  -- chunk done, pausing ${CHUNK_PAUSE}s --"; sleep "$CHUNK_PAUSE"; fi
done

echo "slimmed=$done_count skipped=$skip_count; waiting ${SETTLE}s for re-enumeration..."
sleep "$SETTLE"

echo "restarting daemon..."
systemctl reset-failed sms-daemon 2>/dev/null
systemctl start sms-daemon
sleep 2
systemctl is-active sms-daemon
