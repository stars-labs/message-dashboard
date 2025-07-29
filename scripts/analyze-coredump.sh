#!/bin/bash

# Script to analyze coredumps on Orange Pi and get better stack traces

echo "=== SMS Daemon Crash Analysis ==="
echo
echo "1. Listing recent coredumps:"
coredumpctl list --no-pager | grep sms-daemon | tail -10

echo
echo "2. Most recent crash info:"
coredumpctl info -1 sms-daemon --no-pager

echo
echo "3. Getting backtrace with debug symbols:"
echo "Running: coredumpctl gdb -1 sms-daemon"
echo "In gdb, run these commands:"
echo "  bt full      # Full backtrace"
echo "  info threads # Show all threads"
echo "  thread apply all bt # Backtrace for all threads"
echo "  quit"

echo
echo "4. Checking journalctl for error patterns before crash:"
journalctl -u sms-daemon --no-pager | grep -B20 "panic\|SIGABRT\|unreachable" | tail -50

echo
echo "5. Memory usage before crashes:"
journalctl -u sms-daemon --no-pager | grep -E "memory|Memory|heap|allocation" | tail -20

echo
echo "6. Checking for file descriptor leaks:"
echo "Current daemon PID (if running):"
systemctl status sms-daemon --no-pager | grep "Main PID"
DAEMON_PID=$(systemctl show -p MainPID sms-daemon | cut -d= -f2)
if [ "$DAEMON_PID" != "0" ]; then
    echo "Open files for PID $DAEMON_PID:"
    ls -la /proc/$DAEMON_PID/fd/ | wc -l
fi