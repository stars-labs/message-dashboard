# Security Policy

## 🔒 Reporting Security Vulnerabilities

We take the security of our SMS Dashboard system seriously. If you discover a security vulnerability, please follow these steps:

### 📧 How to Report

1. **DO NOT** create a public GitHub issue for security vulnerabilities
2. Email security concerns to: [security@example.com] <!-- Replace with your email -->
3. Include the following information:
   - Type of vulnerability
   - Full paths of source file(s) related to the issue
   - Location of affected code (tag/branch/commit or direct URL)
   - Step-by-step instructions to reproduce
   - Proof-of-concept or exploit code (if possible)
   - Impact assessment

### ⏱️ Response Timeline

- **Initial Response**: Within 48 hours
- **Status Update**: Within 7 days
- **Resolution Target**: 
  - Critical: 7 days
  - High: 14 days
  - Medium: 30 days
  - Low: 90 days

## 🛡️ Security Measures

### Infrastructure Security

- **NixOS**: Declarative, reproducible system configuration
- **Cloudflare Workers**: Edge computing with built-in DDoS protection
- **D1 Database**: Encrypted at rest with automatic backups
- **API Authentication**: Dual auth system (Auth0 for users, API keys for daemons)

### Application Security

#### Frontend
- **Content Security Policy (CSP)** headers
- **XSS Protection** via framework sanitization
- **HTTPS Only** with HSTS enabled
- **SameSite Cookies** for CSRF protection

#### Backend
- **Input Validation** on all API endpoints
- **SQL Injection Protection** via prepared statements
- **Rate Limiting** on API endpoints
- **Request Size Limits** to prevent DoS

#### Zig Daemon
- **Memory Safety** through Zig's compile-time checks
- **No Buffer Overflows** with bounds checking
- **Safe String Handling** with proper allocators
- **Privilege Separation** (runs as non-root user)

### Data Protection

- **Encryption in Transit**: TLS 1.3 minimum
- **Encryption at Rest**: Database encryption
- **PII Handling**: Phone numbers partially masked in logs
- **No Sensitive Data in Logs**: API keys and passwords filtered
- **Secure Secret Storage**: Environment variables and SOPS

## 🔍 Security Scanning

We employ multiple automated security scanning tools:

### Continuous Integration
- **CodeQL**: Static analysis for vulnerabilities
- **Semgrep**: SAST with OWASP rules
- **Gitleaks**: Secret detection
- **npm audit**: Dependency vulnerabilities
- **OWASP Dependency Check**: Known vulnerability scanning

### Periodic Scans
- **Weekly Security Reports**: Automated vulnerability summaries
- **OpenSSF Scorecard**: Security best practices evaluation
- **License Compliance**: Ensure compatible open-source licenses

## 📋 Security Checklist for Contributors

Before submitting a PR, ensure:

- [ ] No hardcoded secrets, API keys, or passwords
- [ ] All user input is validated and sanitized
- [ ] SQL queries use prepared statements
- [ ] New dependencies are from trusted sources
- [ ] No use of `eval()` or similar dangerous functions
- [ ] Error messages don't leak sensitive information
- [ ] Proper authentication checks on new endpoints
- [ ] Rate limiting considered for new APIs
- [ ] Security headers included for web responses
- [ ] Logging doesn't include sensitive data

## 🚨 Known Security Considerations

### SMS Content
- SMS messages may contain sensitive data (OTPs, verification codes)
- Messages are stored encrypted in the database
- Access requires proper authentication
- Automatic cleanup of old messages recommended

### API Keys
- Orange Pi daemons use API keys for authentication
- Keys should be rotated periodically
- Keys must be transmitted over HTTPS only
- Failed authentication attempts are logged

### Phone Numbers
- Treated as PII (Personally Identifiable Information)
- Partially masked in logs and error messages
- Full numbers only visible to authenticated users
- ICCID mappings provide additional privacy layer

## 🛠️ Security Tools Configuration

### npm audit
```bash
cd sms-dashboard
npm audit --production  # Check production dependencies
npm audit fix          # Auto-fix vulnerabilities
```

### Zig Security Checks
```bash
cd orange-pi-daemon
zig build-exe src/main.zig -O ReleaseSafe  # Enable safety checks
zig test src/tests.zig -fsanitize=undefined  # Run with sanitizers
```

### Manual Security Testing
```bash
# Check for exposed secrets
gitleaks detect --source . -v

# Scan for vulnerabilities
semgrep --config=auto .

# Check dependencies
npm list --depth=0 | grep -E "(lodash|jquery|bootstrap)" # Known vulnerable packages
```

## 📚 Security Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [CWE/SANS Top 25](https://cwe.mitre.org/top25/)
- [Zig Safety Documentation](https://ziglang.org/documentation/master/#Safety)
- [Cloudflare Security Best Practices](https://developers.cloudflare.com/workers/platform/security/)

## 🔄 Version Support

| Version | Supported | Security Updates |
|---------|-----------|------------------|
| 1.21.x  | ✅ Active | Yes |
| 1.20.x  | ⚠️ Maintenance | Critical only |
| < 1.20  | ❌ EOL | No |

## 📞 Contact

- **Security Issues**: [security@example.com] <!-- Replace with your email -->
- **General Questions**: Use GitHub Discussions
- **Bug Reports**: Use GitHub Issues (non-security)

---

*This security policy is regularly reviewed and updated. Last update: January 2025*