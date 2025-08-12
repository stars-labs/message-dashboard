# Test Phone Deselection Fix

## Issue Description
When unselecting a phone in the SMS dashboard, the "最新消息 (所有设备)" (Latest messages from all devices) view was not refreshing to show all messages from all devices. It was still showing only messages from the previously selected phone.

## Root Cause
The reactive statement in `App.svelte` was only triggering when `selectedPhoneIccid` had a truthy value:

```javascript
// OLD CODE - only triggers when selectedPhoneIccid is truthy
$: if (selectedPhoneIccid) {
  loadMessagesForPhone(selectedPhoneIccid);
}
```

This meant that when a phone was unselected (`selectedPhoneIccid` became `null`), the reactive statement would not trigger, and `loadMessagesForPhone(null)` would not be called.

## Solution
Changed the reactive statement to trigger on any change to `selectedPhoneIccid`, including when it becomes `null`:

```javascript
// NEW CODE - triggers on any change to selectedPhoneIccid
$: {
  console.debug('[App] Phone selection changed to:', selectedPhoneIccid);
  loadMessagesForPhone(selectedPhoneIccid);
}
```

## Enhanced Debug Logging
Added more debug logging to `loadMessagesForPhone` to track when all messages are loaded:

```javascript
if (!phoneIccid) {
  // No phone selected, load ALL messages from all devices
  console.debug('[App] No phone selected, loading all messages from all devices');
  
  // ... API call ...
  
  // Debug: Show unique ICCIDs in the messages
  const uniqueIccids = [...new Set(response.data.map(m => m.phone_iccid))];
  console.debug(`[App] Messages from ${uniqueIccids.length} different devices:`, uniqueIccids);
  
  console.debug(`[App] Now displaying ${messages.length} messages from ALL devices`);
}
```

## Testing Steps
1. Load the SMS dashboard
2. Select any phone from the phone list
3. Verify that only messages from that phone are shown
4. Click the same phone again to unselect it
5. Verify that:
   - The header changes to "最新消息 (所有设备)"
   - Messages from ALL devices are now displayed
   - Browser console shows debug logs indicating all messages were loaded

## Files Modified
- `/home/freeman.xiong/Documents/github/hecoinfo/message-dashboard/sms-dashboard/client/App.svelte`
  - Fixed reactive statement (lines 25-29)
  - Enhanced debug logging in `loadMessagesForPhone` function (lines 727-745)

## Expected Behavior After Fix
- When a phone is selected: Shows only messages from that phone
- When a phone is unselected: Shows messages from ALL devices
- Header correctly reflects the current state
- Debug console shows appropriate logging for both scenarios