# Secrets Management with SOPS

This directory contains encrypted secrets for the SMS Dashboard deployment.

## Setup

1. **Install SOPS and age**:
   ```bash
   # macOS
   brew install sops age
   
   # Linux
   nix-env -iA nixpkgs.sops nixpkgs.age
   ```

2. **Edit secrets**:
   ```bash
   # Edit the secrets file (will open in your default editor)
   sops secrets/orange-pi.yaml
   ```

3. **Encrypt after editing**:
   ```bash
   # SOPS automatically encrypts when you save and exit
   # Or manually encrypt:
   sops -e -i secrets/orange-pi.yaml
   ```

## Orange Pi Secrets

The `orange-pi.yaml` file contains:
- `sms-dashboard.api-key`: API key for authenticating with the dashboard

The API URL is configured directly in the flake.nix file.

## Adding New Recipients

To add a new age key to the recipients:

1. Generate a new age key on the target machine:
   ```bash
   age-keygen -o key.txt
   ```

2. Add the public key to `.sops.yaml` in the root directory

3. Re-encrypt the secrets:
   ```bash
   sops updatekeys secrets/orange-pi.yaml
   ```

## Deployment

The NixOS configuration automatically decrypts these secrets during deployment.
No manual decryption is needed.