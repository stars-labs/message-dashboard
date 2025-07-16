# Example NixOS configuration for SMS daemon with different log levels

{ config, pkgs, ... }:

{
  # Import the SMS daemon module
  imports = [ ../modules/sms-daemon.nix ];

  # SMS daemon configuration examples
  services.sms-daemon = {
    enable = true;
    
    # API configuration
    apiUrl = "https://sexy.qzz.io";
    apiKeyFile = "/run/secrets/sms-api-key"; # Use SOPS or other secret management
    
    # Upload interval (in seconds)
    uploadInterval = 60;
    
    # Log level configuration
    # Options: "debug", "info", "warn", "err"
    # Default is "info"
    logLevel = "info";  # Change to "debug" for verbose logging
    
    # Build in debug mode for maximum verbosity
    # This will show raw JSON messages and other debug information
    # Default is false (optimized release build)
    debugBuild = false;  # Set to true for development/troubleshooting
    
    # Custom package (optional - will use default if not specified)
    # package = pkgs.sms-daemon;
  };

  # Example configurations for different scenarios:
  
  # 1. Production configuration (minimal logging)
  # services.sms-daemon = {
  #   enable = true;
  #   apiUrl = "https://sexy.qzz.io";
  #   apiKeyFile = "/run/secrets/sms-api-key";
  #   logLevel = "warn";  # Only warnings and errors
  #   debugBuild = false;
  # };
  
  # 2. Development configuration (verbose logging)
  # services.sms-daemon = {
  #   enable = true;
  #   apiUrl = "https://test.example.com";
  #   apiKey = "test-key-only-for-dev";  # Don't use in production!
  #   logLevel = "debug";  # All log messages
  #   debugBuild = true;   # Debug build with raw JSON output
  # };
  
  # 3. Troubleshooting configuration
  # services.sms-daemon = {
  #   enable = true;
  #   apiUrl = "https://sexy.qzz.io";
  #   apiKeyFile = "/run/secrets/sms-api-key";
  #   logLevel = "info";   # Normal info logging
  #   debugBuild = true;   # But with debug build for raw JSON
  #   uploadInterval = 30; # More frequent uploads for testing
  # };
}