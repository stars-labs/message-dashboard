{ lib, stdenv, zig, fetchFromGitHub }:

stdenv.mkDerivation rec {
  pname = "sms-daemon";
  version = "0.1.0";

  # Use local source or fetch from git
  src = ../../orange-pi-daemon;  # Relative path to the zig source

  nativeBuildInputs = [ zig ];

  buildPhase = ''
    runHook preBuild
    zig build -Doptimize=ReleaseSafe
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    cp zig-out/bin/orange-pi-daemon $out/bin/sms-daemon
    runHook postInstall
  '';

  meta = with lib; {
    description = "SMS Dashboard Daemon for Orange Pi with 3G/4G modems";
    longDescription = ''
      A daemon that monitors 3G/4G modems using ModemManager (mmcli),
      collects SMS messages and phone status information, and forwards
      them to the SMS Dashboard server API.
    '';
    homepage = "https://github.com/your-org/message-dashboard";
    license = licenses.mit;
    maintainers = with maintainers; [ ];
    platforms = platforms.linux;
  };
}