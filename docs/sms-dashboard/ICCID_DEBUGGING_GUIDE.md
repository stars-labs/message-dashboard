# ICCID Mappings Debugging Guide

> **Historical guide:** `iccid_mappings` was removed by migration `015`; current
> mapping data is stored in `sims`. Do not run the migration commands below against
> production. Follow [`../../AGENTS.md`](../../AGENTS.md) and inspect the current
> schema before applying one exact new migration.

## Issue Summary
The ICCID mappings page shows "Failed to load ICCID mappings" error. This document provides steps to debug and fix the issue.

## Potential Issues Identified

### 1. Database Table Missing
The `iccid_mappings` table might not exist in the production database.

**Solution**: Run the migration created at `/migrations/0004_add_iccid_mappings.sql`
```bash
bunx wrangler d1 migrations apply sms-dashboard
```

### 2. Authentication Issue in fetchWithAuth
The `fetchWithAuth` function in `/client/lib/api.js` returns `undefined` on 401 errors instead of proper error handling.

**Fix**: Update the function to properly handle errors:
```javascript
if (response.status === 401) {
    // Token expired or invalid, redirect to login
    auth.logout();
    throw new Error('Authentication required');
}
```

### 3. CORS Issues
Check if CORS headers are properly set for the API endpoints.

## Debugging Steps

### Step 1: Use the Debug Tool
1. Open `/test-iccid-api.html` in a browser
2. Navigate to the site and log in if needed
3. The tool will automatically retrieve the auth token from localStorage
4. Click "Test /api/iccid-mappings" to test the endpoint
5. Check the response and logs for errors

### Step 2: Check Browser Console
1. Open the website at https://sexy.qzz.io
2. Open Developer Tools (F12)
3. Go to the ICCID mappings tab
4. Check the Console tab for errors
5. Check the Network tab for failed API calls

### Step 3: Check Database
```bash
# List all tables in the database
bunx wrangler d1 execute sms-dashboard --command "SELECT name FROM sqlite_master WHERE type='table';"

# Check if iccid_mappings table exists
bunx wrangler d1 execute sms-dashboard --command "SELECT * FROM iccid_mappings LIMIT 1;"
```

### Step 4: Test API Directly
```bash
# Get auth token from browser localStorage
# Then test the API endpoint
curl -H "Authorization: Bearer YOUR_TOKEN_HERE" \
     -H "Content-Type: application/json" \
     https://sexy.qzz.io/api/iccid-mappings
```

## Common Error Messages and Solutions

### "Failed to load ICCID mappings"
- **Cause**: Generic error from the frontend when API call fails
- **Solution**: Check network tab for actual error response

### 401 Unauthorized
- **Cause**: Invalid or expired auth token
- **Solution**: Log out and log in again

### 500 Internal Server Error
- **Cause**: Database table missing or query error
- **Solution**: Run migrations and check database schema

### Network Error
- **Cause**: CORS issue or network connectivity
- **Solution**: Check CORS headers and network connectivity

## Quick Fix Checklist
- [ ] Run database migrations
- [ ] Fix fetchWithAuth error handling
- [ ] Clear browser cache and localStorage
- [ ] Re-authenticate (logout and login)
- [ ] Check browser console for specific errors
- [ ] Test API endpoint directly with curl
- [ ] Verify database table exists
