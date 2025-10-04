# Add these sections to your existing flake.nix
# This is a reference file showing what to add, not a complete flake

# ============================================================================
# SECTION 1: Add to the 'let' block in perSystem (around line 128)
# ============================================================================

# After the existing sms-daemon-debug definition, add:

# Rust daemon package
sms-daemon-rust = pkgs.rustPlatform.buildRustPackage {
  pname = "sms-daemon-rust";
  version = "1.0.0";
  
  src = ./orange-pi-daemon-rust;
  
  cargoLock = {
    lockFile = ./orange-pi-daemon-rust/Cargo.lock;
  };
  
  nativeBuildInputs = with pkgs; [ 
    pkg-config 
  ];
  
  buildInputs = with pkgs; [ 
    openssl
    dbus
  ];
  
  # Rename binary to match expected name
  postInstall = ''
    mv $out/bin/orange-pi-daemon-rust $out/bin/sms-daemon
  '';
  
  meta = with lib; {
    description = "SMS Dashboard Daemon (Rust) - Memory-safe replacement";
    longDescription = ''
      Memory-safe Rust rewrite of the SMS daemon. Monitors 3G/4G modems
      via ModemManager, collects SMS and status, forwards to API.
      Single-threaded async for simplicity and reliability.
    '';
    homepage = "https://github.com/hecoinfo/message-dashboard";
    license = licenses.mit;
    platforms = platforms.linux;
  };
};

# ============================================================================
# SECTION 2: Update packages export (around line 183)
# ============================================================================

# Replace:
packages = {
  inherit sms-daemon sms-daemon-debug;
  default = sms-daemon;
};

# With:
packages = {
  inherit sms-daemon sms-daemon-debug sms-daemon-rust;
  default = sms-daemon;
};

# ============================================================================
# SECTION 3: Update NixOS configuration (around line 92-105)
# ============================================================================

# Replace:
services.sms-daemon = {
  enable = true;
  package =
    if config.services.sms-daemon.debugBuild then
      self.packages.aarch64-linux.sms-daemon-debug
    else
      self.packages.aarch64-linux.sms-daemon;
  apiKeyFile = config.sops.secrets."sms-dashboard/api-key".path;
  apiUrl = "https://sexy.qzz.io";
  phoneUpdateIntervalSeconds = 30;
  messageCheckIntervalMs = 50;
  signalCheckIntervalSeconds = 60;
  debugBuild = true;
};

# With:
services.sms-daemon = {
  enable = true;
  
  # Choose daemon implementation
  useRustDaemon = false;  # Set to true to use Rust daemon
  
  package =
    if config.services.sms-daemon.useRustDaemon then
      self.packages.aarch64-linux.sms-daemon-rust
    else if config.services.sms-daemon.debugBuild then
      self.packages.aarch64-linux.sms-daemon-debug
    else
      self.packages.aarch64-linux.sms-daemon;
  
  apiKeyFile = config.sops.secrets."sms-dashboard/api-key".path;
  apiUrl = "https://sexy.qzz.io";
  
  # Zig-specific settings (ignored by Rust daemon)
  phoneUpdateIntervalSeconds = 30;
  messageCheckIntervalMs = 50;
  signalCheckIntervalSeconds = 60;
  debugBuild = false;
};

# ============================================================================
# SECTION 4: Optional - Add Rust dev shell (around line 217)
# ============================================================================

# After the existing daemon dev shell, add:
daemon-rust = pkgs.mkShell {
  packages = with pkgs; [
    rustc
    cargo
    rust-analyzer
    rustfmt
    clippy
    pkg-config
    openssl
    dbus
    modemmanager
  ];
  
  shellHook = ''
    echo "Rust SMS Daemon Development"
    echo "Run 'cargo build' to compile"
    echo "Run 'cargo test' to run tests"
    echo "Run 'cargo clippy' for linting"
  '';
};

# ============================================================================
# USAGE EXAMPLES
# ============================================================================

# Build Rust daemon:
# nix build .#sms-daemon-rust

# Enter Rust dev shell:
# nix develop .#daemon-rust

# Deploy with Rust daemon:
# 1. Set useRustDaemon = true in flake.nix
# 2. nixos-rebuild switch --flake .#orange-pi ...

# Deploy with Zig daemon (rollback):
# 1. Set useRustDaemon = false in flake.nix
# 2. nixos-rebuild switch --flake .#orange-pi ...
