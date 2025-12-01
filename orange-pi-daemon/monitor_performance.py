#!/usr/bin/env python3
"""
SMS Daemon Performance Monitor
Real-time performance tracking for v7.0.0 optimizations
"""

import re
import time
import subprocess
import statistics
from datetime import datetime, timedelta
from collections import deque
from typing import List, Dict, Optional

class PerformanceMonitor:
    def __init__(self, log_file: str = None):
        self.log_file = log_file
        self.message_rates = deque(maxlen=60)  # Last 60 measurements
        self.upload_rates = deque(maxlen=60)
        self.modem_rates = deque(maxlen=60)
        self.start_time = datetime.now()
        self.total_messages = 0
        self.total_uploads = 0
        self.backlog_size = 0

    def parse_log_line(self, line: str) -> Dict:
        """Parse a log line for performance metrics"""
        metrics = {}

        # Parse message storage from modem reader
        # Example: "📥 Modem reader: Stored 42 new messages in 1.2s"
        stored_match = re.search(r'Modem reader: Stored (\d+) new messages in ([\d.]+)', line)
        if stored_match:
            count = int(stored_match.group(1))
            duration = float(stored_match.group(2).rstrip('s'))
            metrics['messages_stored'] = count
            metrics['store_duration'] = duration
            metrics['store_rate'] = count / duration if duration > 0 else 0

        # Parse uploads
        # Example: "☁️  Uploader: Sent 200 messages to Cloudflare"
        upload_match = re.search(r'Uploader: Sent (\d+) messages', line)
        if upload_match:
            metrics['messages_uploaded'] = int(upload_match.group(1))

        # Parse database stats
        # Example: "📊 Database stats: 12345 pending, 0 uploading, 5678 uploaded, 0 failed"
        stats_match = re.search(r'Database stats: (\d+) pending, (\d+) uploading, (\d+) uploaded, (\d+) failed', line)
        if stats_match:
            metrics['db_pending'] = int(stats_match.group(1))
            metrics['db_uploading'] = int(stats_match.group(2))
            metrics['db_uploaded'] = int(stats_match.group(3))
            metrics['db_failed'] = int(stats_match.group(4))

        # Parse worker pool stats
        # Example: "✅ Worker pool completed: 91 modems in 8.50s (89 successful, 2 failed, 0 timeouts, 97.8% success rate)"
        worker_match = re.search(r'Worker pool completed: (\d+) modems in ([\d.]+)s \((\d+) successful, (\d+) failed, (\d+) timeouts, ([\d.]+)% success', line)
        if worker_match:
            metrics['modems_processed'] = int(worker_match.group(1))
            metrics['worker_duration'] = float(worker_match.group(2))
            metrics['modems_successful'] = int(worker_match.group(3))
            metrics['modems_failed'] = int(worker_match.group(4))
            metrics['modems_timeout'] = int(worker_match.group(5))
            metrics['success_rate'] = float(worker_match.group(6))

        return metrics

    def calculate_rates(self) -> Dict:
        """Calculate current performance rates"""
        rates = {}

        if self.message_rates:
            rates['msg_rate_avg'] = statistics.mean(self.message_rates)
            rates['msg_rate_max'] = max(self.message_rates)
            rates['msg_rate_current'] = self.message_rates[-1] if self.message_rates else 0

        if self.upload_rates:
            rates['upload_rate_avg'] = statistics.mean(self.upload_rates)
            rates['upload_rate_current'] = self.upload_rates[-1] if self.upload_rates else 0

        if self.modem_rates:
            rates['modem_rate_avg'] = statistics.mean(self.modem_rates)

        return rates

    def estimate_completion(self) -> Optional[timedelta]:
        """Estimate time to clear backlog"""
        if self.backlog_size > 0 and self.upload_rates:
            avg_rate = statistics.mean(self.upload_rates)
            if avg_rate > 0:
                seconds_remaining = self.backlog_size / avg_rate
                return timedelta(seconds=seconds_remaining)
        return None

    def print_dashboard(self):
        """Print performance dashboard"""
        rates = self.calculate_rates()
        runtime = datetime.now() - self.start_time

        print("\033[2J\033[H")  # Clear screen
        print("=" * 70)
        print("SMS DAEMON PERFORMANCE MONITOR - v7.0.0")
        print("=" * 70)
        print(f"Runtime: {runtime}")
        print(f"Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print()

        print("MESSAGE PROCESSING:")
        print(f"  Current Rate: {rates.get('msg_rate_current', 0):.1f} msg/sec")
        print(f"  Average Rate: {rates.get('msg_rate_avg', 0):.1f} msg/sec")
        print(f"  Peak Rate:    {rates.get('msg_rate_max', 0):.1f} msg/sec")
        print(f"  Total Stored: {self.total_messages:,}")
        print()

        print("UPLOAD PERFORMANCE:")
        print(f"  Current Rate: {rates.get('upload_rate_current', 0):.1f} msg/sec")
        print(f"  Average Rate: {rates.get('upload_rate_avg', 0):.1f} msg/sec")
        print(f"  Total Uploaded: {self.total_uploads:,}")
        print()

        print("BACKLOG STATUS:")
        print(f"  Pending Messages: {self.backlog_size:,}")
        completion = self.estimate_completion()
        if completion:
            print(f"  Est. Clear Time: {completion}")
            print(f"  Est. Complete At: {(datetime.now() + completion).strftime('%H:%M:%S')}")
        print()

        print("OPTIMIZATION METRICS:")
        if rates.get('msg_rate_avg', 0) > 0:
            improvement = rates.get('msg_rate_avg', 0) / 0.3  # vs original 0.3 msg/sec
            print(f"  vs v6.9.0: {improvement:.1f}x faster")
            improvement_v7 = rates.get('msg_rate_avg', 0) / 12.5  # vs v7.0.0 baseline
            print(f"  vs v7.0.0: {improvement_v7:.1f}x faster")
        print()

        print("=" * 70)
        print("Press Ctrl+C to exit")

    def monitor_live(self, command: str = "journalctl -u sms-daemon -f"):
        """Monitor live performance from systemd logs"""
        try:
            process = subprocess.Popen(
                command.split(),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=True
            )

            while True:
                line = process.stdout.readline()
                if not line:
                    break

                metrics = self.parse_log_line(line)

                if 'store_rate' in metrics:
                    self.message_rates.append(metrics['store_rate'])
                    self.total_messages += metrics.get('messages_stored', 0)

                if 'messages_uploaded' in metrics:
                    # Assume uploads take ~1 second for rate calculation
                    self.upload_rates.append(metrics['messages_uploaded'])
                    self.total_uploads += metrics['messages_uploaded']

                if 'db_pending' in metrics:
                    self.backlog_size = metrics['db_pending']

                if 'modems_processed' in metrics and 'worker_duration' in metrics:
                    rate = metrics['modems_processed'] / metrics['worker_duration']
                    self.modem_rates.append(rate)

                # Update dashboard every time we get meaningful metrics
                if metrics:
                    self.print_dashboard()

        except KeyboardInterrupt:
            print("\n\nMonitoring stopped.")
        except Exception as e:
            print(f"Error: {e}")
        finally:
            if 'process' in locals():
                process.terminate()

    def analyze_log_file(self, file_path: str):
        """Analyze a log file for performance metrics"""
        print(f"Analyzing log file: {file_path}")

        with open(file_path, 'r') as f:
            for line in f:
                metrics = self.parse_log_line(line)

                if 'store_rate' in metrics:
                    self.message_rates.append(metrics['store_rate'])
                    self.total_messages += metrics.get('messages_stored', 0)

                if 'messages_uploaded' in metrics:
                    self.upload_rates.append(metrics['messages_uploaded'])
                    self.total_uploads += metrics['messages_uploaded']

                if 'db_pending' in metrics:
                    self.backlog_size = metrics['db_pending']

        self.print_dashboard()
        print("\n\nAnalysis complete!")

        # Print summary statistics
        if self.message_rates:
            print("\nPERFORMANCE SUMMARY:")
            print(f"  Message Processing:")
            print(f"    Average: {statistics.mean(self.message_rates):.2f} msg/sec")
            print(f"    Median:  {statistics.median(self.message_rates):.2f} msg/sec")
            print(f"    StdDev:  {statistics.stdev(self.message_rates):.2f}" if len(self.message_rates) > 1 else "")
            print(f"    Peak:    {max(self.message_rates):.2f} msg/sec")

        if self.upload_rates:
            print(f"  Upload Performance:")
            print(f"    Average: {statistics.mean(self.upload_rates):.2f} msg/batch")
            print(f"    Total:   {self.total_uploads:,} messages")

def main():
    import argparse

    parser = argparse.ArgumentParser(description='SMS Daemon Performance Monitor')
    parser.add_argument('--live', action='store_true', help='Monitor live performance')
    parser.add_argument('--file', type=str, help='Analyze a log file')
    parser.add_argument('--command', type=str, default='journalctl -u sms-daemon -f',
                       help='Command to get live logs (default: journalctl -u sms-daemon -f)')

    args = parser.parse_args()

    monitor = PerformanceMonitor()

    if args.live:
        print("Starting live performance monitoring...")
        print("Waiting for log data...")
        monitor.monitor_live(args.command)
    elif args.file:
        monitor.analyze_log_file(args.file)
    else:
        print("Live monitoring from current cargo run output...")
        monitor.monitor_live("cargo run --release")

if __name__ == '__main__':
    main()