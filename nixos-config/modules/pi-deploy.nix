# CI builds the Orange Pi system and pushes it to the Cachix cache below, so the
# Pi downloads instead of compiling (sparing the SD card and CPU). The switch runs
# as a transient systemd unit so a dropped SSH session cannot interrupt it.
{ pkgs, ... }:

let
  cache = {
    url = "https://xiongchenyu6.cachix.org";
    key = "xiongchenyu6.cachix.org-1:mpOGlINmMwc2gb3xb1BjVmhzR8BYWzWYlg4xlTiBr7Q=";
  };

  pi-deploy-run = pkgs.writeShellApplication {
    name = "pi-deploy-run";
    runtimeInputs = [ pkgs.nix ];
    text = ''
      target="$1"
      echo "realising $target"
      out=$(nix-store --realise "$target")
      echo "out=$out"
      nix-env -p /nix/var/nix/profiles/system --set "$out"
      echo "profile set; switching"
      "$out"/bin/switch-to-configuration switch
      echo "switch done"
    '';
  };

  pi-deploy = pkgs.writeShellApplication {
    name = "pi-deploy";
    runtimeInputs = [
      pkgs.systemd
      pkgs.coreutils
    ];
    text = ''
      if [ $# -ne 1 ]; then
        echo "usage: pi-deploy <nixos-system store path or .drv>" >&2
        exit 64
      fi
      systemctl reset-failed pi-deploy.service 2>/dev/null || true
      systemd-run --unit=pi-deploy --quiet ${pi-deploy-run}/bin/pi-deploy-run "$1"
      journalctl -u pi-deploy -f -o cat -n 0 &
      tail=$!
      while systemctl is-active -q pi-deploy.service; do sleep 3; done
      sleep 1
      kill "$tail" 2>/dev/null || true
      if systemctl is-failed -q pi-deploy.service; then
        echo "pi-deploy failed; see journalctl -u pi-deploy" >&2
        exit 1
      fi
    '';
  };
in
{
  nix.settings = {
    extra-substituters = [ cache.url ];
    extra-trusted-public-keys = [ cache.key ];
  };

  environment.systemPackages = [ pi-deploy ];
}
