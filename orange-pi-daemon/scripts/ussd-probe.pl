#!/usr/bin/env perl

use strict;
use warnings;

use Fcntl qw(O_NOCTTY O_RDWR);
use POSIX qw(:termios_h);
use Time::HiRes qw(time sleep);

sub usage {
    die "Usage: $0 /dev/ttyUSB<N> '<USSD code>' [timeout seconds]\n";
}

my ($port, $code, $timeout) = @ARGV;
usage() unless defined $port && defined $code;

$timeout = 30 unless defined $timeout;
die "Invalid modem port\n" unless $port =~ m{\A/dev/ttyUSB\d+\z};
die "Invalid USSD code\n" unless $code =~ /\A[*#0-9]+#\z/;
die "Timeout must be between 5 and 60 seconds\n"
    unless $timeout =~ /\A\d+\z/ && $timeout >= 5 && $timeout <= 60;

if (system("systemctl", "is-active", "--quiet", "sms-daemon") == 0) {
    die "Refusing to open $port while sms-daemon is active\n";
}

sysopen(my $serial, $port, O_RDWR | O_NOCTTY)
    or die "Cannot open $port: $!\n";

my $termios = POSIX::Termios->new();
$termios->getattr(fileno($serial));
# Preserve the baud rate configured by the daemon; only switch line discipline.
$termios->setiflag(0);
$termios->setoflag(0);
$termios->setlflag(0);
$termios->setcflag(CS8 | CREAD | CLOCAL);
$termios->setcc(VMIN, 0);
$termios->setcc(VTIME, 1);
$termios->setattr(fileno($serial), POSIX::TCSANOW());
POSIX::tcflush(fileno($serial), TCIOFLUSH);

sub write_command {
    my ($fh, $command) = @_;
    my $payload = "$command\r";
    my $written = syswrite($fh, $payload);
    die "Failed to write $command: $!\n"
        unless defined $written && $written == length($payload);
}

sub read_available {
    my ($fh, $wait_seconds) = @_;
    my $read_set = "";
    vec($read_set, fileno($fh), 1) = 1;
    my $ready = select(my $ready_set = $read_set, undef, undef, $wait_seconds);
    return "" unless $ready;

    my $chunk = "";
    my $count = sysread($fh, $chunk, 4096);
    die "Failed to read modem response: $!\n" unless defined $count;
    return $chunk;
}

my $response = "";
my $outcome = "timeout";
my $started_at = time();

write_command($serial, "AT+CMEE=2");
my $setup_deadline = time() + 2;
while (time() < $setup_deadline) {
    my $chunk = read_available($serial, 0.2);
    $response .= $chunk if length $chunk;
    last if $response =~ /(?:\r\n|\A)OK\r\n/s;
}
die "Modem did not accept AT+CMEE=2\n"
    unless $response =~ /(?:\r\n|\A)OK\r\n/s;

$response = "";
write_command($serial, qq{AT+CUSD=1,"$code"});

while (time() - $started_at < $timeout) {
    my $chunk = read_available($serial, 0.25);
    next unless length $chunk;

    $response .= $chunk;
    if ($response =~ /\+CUSD:\s*[012],/s) {
        $outcome = "response";
        last;
    }
    if ($response =~ /(?:\+CME ERROR:|\bERROR\b)/s) {
        $outcome = "modem_error";
        last;
    }
}

# Always terminate a possibly open interactive session before releasing the port.
write_command($serial, "AT+CUSD=2");
my $cancel_deadline = time() + 2;
while (time() < $cancel_deadline) {
    my $chunk = read_available($serial, 0.2);
    $response .= $chunk if length $chunk;
}

close($serial) or die "Failed to close $port: $!\n";

print "port=$port\n";
print "code=$code\n";
printf "elapsed_seconds=%.3f\n", time() - $started_at;
print "outcome=$outcome\n";
print "response_begin\n$response\nresponse_end\n";

exit 0 if $outcome eq "response";
exit 2 if $outcome eq "modem_error";
exit 3;
