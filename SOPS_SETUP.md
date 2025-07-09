# SOPS Setup Guide for SMS Dashboard

## Overview

SOPS (Secrets OPerationS) is used to securely manage secrets in the repository. This guide shows how to set up and use SOPS for the SMS Dashboard.

## Installation

### macOS
```bash
brew install sops age
```

### Linux
```bash
# Download SOPS
wget https://github.com/mozilla/sops/releases/download/v3.8.1/sops-v3.8.1.linux
chmod +x sops-v3.8.1.linux
sudo mv sops-v3.8.1.linux /usr/local/bin/sops

# Install age
wget https://github.com/FiloSottile/age/releases/download/v1.1.1/age-v1.1.1-linux-amd64.tar.gz
tar -xzf age-v1.1.1-linux-amd64.tar.gz
sudo mv age/age /usr/local/bin/
sudo mv age/age-keygen /usr/local/bin/
```

## Generate Encryption Key

### Using Age (Recommended)
```bash
# Generate a new key pair
age-keygen -o key.txt

# The output will show:
# Public key: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
# Save the private key securely!
```

### Update .sops.yaml
Update `workers-api/.sops.yaml` with your public key:
```yaml
creation_rules:
  - path_regex: secrets\.enc\.yaml$
    age: age1YOUR_PUBLIC_KEY_HERE
```

## Encrypt Secrets

1. **Edit secrets.yaml** with your actual values:
```yaml
# workers-api/secrets.yaml
auth0:
  domain: tron.jp.auth0.com
  client_id: ZhBLVZumzA8E71ttXABQzVDdoycyDp9i
  client_secret: wJ6nmNpjJBcDV9cAIccLqadpsAUac2dndB5Q3M6Nrp07lPP-lSqzAPXU_jrOlXyl

api_key: af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae

cloudflare:
  account_id: 2764ae0fd9a5cb92c9ac67708620e54c
  database_id: 14311b51-4169-4449-9f41-30ca4428a76e
  kv_namespace_id: 92704d6efb8d466598db166d944697a7

frontend:
  url: https://sexy.qzz.io
  api_url: https://sms-dashboard-api.xiongchenyu6.workers.dev
```

2. **Encrypt the file**:
```bash
cd workers-api
export SOPS_AGE_KEY_FILE=~/path/to/key.txt
sops -e secrets.yaml > secrets.enc.yaml
```

3. **Add to .gitignore**:
```bash
echo "secrets.yaml" >> .gitignore
echo "key.txt" >> .gitignore
echo "*.key" >> .gitignore
```

4. **Commit encrypted file**:
```bash
git add secrets.enc.yaml .sops.yaml
git commit -m "Add encrypted secrets"
```

## Decrypt Secrets

```bash
# Decrypt to stdout
sops -d secrets.enc.yaml

# Decrypt to file
sops -d secrets.enc.yaml > secrets.yaml

# Edit encrypted file directly
sops secrets.enc.yaml
```

## Deployment Workflow

1. **Clone repository**
2. **Set up SOPS key**:
   ```bash
   export SOPS_AGE_KEY_FILE=~/path/to/key.txt
   ```
3. **Run deployment**:
   ```bash
   cd workers-api
   ./deploy.sh
   ```

## Team Collaboration

### Option 1: Shared Age Key
- Share the private key securely with team members
- Store in password manager
- Each member sets `SOPS_AGE_KEY_FILE`

### Option 2: Multiple Recipients
Update `.sops.yaml` to support multiple team members:
```yaml
creation_rules:
  - path_regex: secrets\.enc\.yaml$
    age: >-
      age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p,
      age1another_team_member_public_key,
      age1yet_another_public_key
```

### Option 3: Use Cloud KMS
For production, consider using cloud KMS:

**AWS KMS**:
```yaml
creation_rules:
  - path_regex: secrets\.enc\.yaml$
    kms: arn:aws:kms:us-east-1:account:key/key-id
```

**GCP KMS**:
```yaml
creation_rules:
  - path_regex: secrets\.enc\.yaml$
    gcp_kms: projects/PROJECT/locations/global/keyRings/KEYRING/cryptoKeys/KEY
```

## GitHub Actions Integration

Add encrypted key to GitHub secrets, then:

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Install SOPS
        run: |
          wget https://github.com/mozilla/sops/releases/download/v3.8.1/sops-v3.8.1.linux
          chmod +x sops-v3.8.1.linux
          sudo mv sops-v3.8.1.linux /usr/local/bin/sops
      
      - name: Setup SOPS
        run: |
          echo "${{ secrets.SOPS_AGE_KEY }}" > key.txt
          export SOPS_AGE_KEY_FILE=key.txt
      
      - name: Deploy
        run: |
          cd workers-api
          ./deploy.sh
```

## Security Best Practices

1. **Never commit**:
   - Unencrypted `secrets.yaml`
   - Private keys (`key.txt`, `*.key`)
   - `.env` files with secrets

2. **Rotate secrets regularly**:
   - API keys every 90 days
   - Auth0 client secret if compromised

3. **Audit access**:
   - Track who has decryption keys
   - Use cloud KMS for audit logs

4. **Backup keys**:
   - Store in password manager
   - Keep offline backup
   - Document recovery process

## Troubleshooting

### "Could not decrypt file"
- Check `SOPS_AGE_KEY_FILE` is set correctly
- Verify you have the correct private key
- Ensure file wasn't corrupted

### "No matching creation rules"
- Check `.sops.yaml` path regex matches your file
- Verify public key in `.sops.yaml` is correct

### Python YAML errors in deploy.sh
```bash
# Install PyYAML
pip3 install pyyaml

# Or use yq instead
brew install yq  # macOS
# or
wget https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -O yq
chmod +x yq
sudo mv yq /usr/local/bin/
```