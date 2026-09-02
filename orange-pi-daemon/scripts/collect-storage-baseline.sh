#!/usr/bin/env bash

set -euo pipefail

host="${1:-root@10.40.0.51}"

if [[ ! "$host" =~ ^[a-zA-Z0-9._@:-]+$ ]]; then
  echo "Invalid SSH host: $host" >&2
  exit 2
fi

# This collector is deliberately read-only. It emits aggregate counters only and
# never issues AT commands or selects message identity/content columns.
ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" 'bash -s' <<'REMOTE'
set -eu

printf 'collected_at='
date -Is

systemctl show sms-daemon \
  --property=ActiveState \
  --property=SubState \
  --property=ExecMainStartTimestamp \
  --no-pager

daemon_pid="$(systemctl show sms-daemon --property=MainPID --value)"
if [ -n "$daemon_pid" ] && [ "$daemon_pid" != "0" ]; then
  printf 'daemon_binary='
  readlink -f "/proc/$daemon_pid/exe"
fi

printf 'journal_usage='
journalctl --disk-usage | sed -E 's/^Archived and active journals take up //'

journalctl -u sms-daemon --since '24 hours ago' -o short-iso --no-pager |
  sed -n -E '1{s/^(.{25}).*/journal_start=\1/p}; ${s/^(.{25}).*/journal_end=\1/p}'

journalctl -u sms-daemon --since '24 hours ago' -o cat --no-pager |
  awk '
    BEGIN {
      scan_count = 0
      scan_sum = 0
      stored_batches = 0
      stored_messages = 0
      reader_failures = 0
      delete_failures = 0
      multipart_completions = 0
    }
    /Worker pool completed:/ {
      if (match($0, /modems in ([0-9.]+)s/, value)) {
        seconds = value[1] + 0
        if (scan_count == 0 || seconds < scan_min) scan_min = seconds
        if (scan_count == 0 || seconds > scan_max) scan_max = seconds
        scan_sum += seconds
        scan_count++
      }
    }
    /Modem reader: Stored/ {
      stored_batches++
      if (match($0, /Stored ([0-9]+) new messages/, value)) {
        stored_messages += value[1]
      }
    }
    /Failed to read SMS from modem|Modem reader error/ { reader_failures++ }
    /DELETION FAILED/ { delete_failures++ }
    /Assembled multipart message/ { multipart_completions++ }
    END {
      printf "scan_count=%d\n", scan_count
      if (scan_count > 0) {
        printf "scan_min_seconds=%.2f\n", scan_min
        printf "scan_avg_seconds=%.2f\n", scan_sum / scan_count
        printf "scan_max_seconds=%.2f\n", scan_max
      }
      printf "stored_batches=%d\n", stored_batches
      printf "stored_messages=%d\n", stored_messages
      printf "reader_failures=%d\n", reader_failures
      printf "delete_failures=%d\n", delete_failures
      printf "multipart_completions=%d\n", multipart_completions
    }
  '

sqlite_bin=""
for candidate in /nix/store/*-sqlite-*-bin/bin/sqlite3; do
  if [ -x "$candidate" ]; then
    sqlite_bin="$candidate"
    break
  fi
done

if [ -z "$sqlite_bin" ]; then
  echo 'sqlite_aggregate_status=unavailable'
  exit 0
fi

"$sqlite_bin" -readonly /var/lib/sms-daemon/messages.db <<'SQL'
.mode list
.separator =
SELECT 'messages_' || status, COUNT(*)
FROM messages
GROUP BY status
ORDER BY status;
SELECT 'messages_24h', COUNT(*)
FROM messages
WHERE created_at > datetime('now', '-24 hours');
SELECT 'multipart_segments', COUNT(*) FROM multipart_segments;
SELECT 'multipart_groups', COUNT(*)
FROM (
  SELECT 1
  FROM multipart_segments
  GROUP BY phone_iccid, sender, ref_id, total_parts
);
SELECT 'multipart_segments_old_5m', COUNT(*)
FROM multipart_segments
WHERE created_at < datetime('now', '-5 minutes');
SQL
REMOTE
