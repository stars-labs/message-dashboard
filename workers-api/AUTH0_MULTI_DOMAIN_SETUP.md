# Auth0 Multi-Domain Configuration

To support both the workers.dev domain and your custom domain (sexy.qzz.io), you need to update your Auth0 application settings to include both domains.

## Auth0 Dashboard Configuration

1. **Log in to Auth0**: https://manage.auth0.com/
2. **Navigate to**: Applications > Your Application > Settings
3. **Update the following fields** to include BOTH domains:

### Allowed Callback URLs
Add both URLs (one per line):
```
https://sms-dashboard.xiongchenyu6.workers.dev/api/auth/callback
https://sexy.qzz.io/api/auth/callback
```

### Allowed Logout URLs
Add both URLs (one per line):
```
https://sms-dashboard.xiongchenyu6.workers.dev
https://sexy.qzz.io
```

### Allowed Web Origins
Add both URLs (one per line):
```
https://sms-dashboard.xiongchenyu6.workers.dev
https://sexy.qzz.io
```

### Allowed Origins (CORS)
Add both URLs (one per line):
```
https://sms-dashboard.xiongchenyu6.workers.dev
https://sexy.qzz.io
```

4. **Save Changes**

## How it Works

The application now:
- Uses the request origin to determine where to redirect after login/logout
- Maintains the domain you're accessing from throughout the authentication flow
- No longer redirects to a hardcoded domain

## Testing

1. Access from https://sexy.qzz.io
   - Login should redirect back to sexy.qzz.io
   - Logout should redirect back to sexy.qzz.io

2. Access from https://sms-dashboard.xiongchenyu6.workers.dev
   - Login should redirect back to workers.dev domain
   - Logout should redirect back to workers.dev domain

Both domains will work independently and maintain their own URLs throughout the user session.