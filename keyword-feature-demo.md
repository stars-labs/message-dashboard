# Keyword Highlighting Feature - Demo Guide

## 🎉 Feature Overview

The keyword highlighting and tagging system is now live at https://sexy.qzz.io! This feature allows you to:

1. **Configure Keywords**: Set up keywords with custom tags, colors, and matching rules
2. **Automatic Highlighting**: Messages containing keywords are automatically highlighted
3. **Tag Display**: Each matched keyword shows its associated tag
4. **Priority System**: Handle overlapping keywords with priority settings
5. **AI Analysis**: Get insights on keyword usage patterns

## 🚀 How to Use

### 1. Access the Keywords Tab

1. Navigate to https://sexy.qzz.io
2. Log in with your Auth0 credentials
3. Click on "关键词高亮" (Keyword Highlighting) in the navigation bar

### 2. Add Keywords

Click "Add Keyword" and configure:
- **Keyword**: The text to match (e.g., "verification", "payment")
- **Tag**: Short label to display (e.g., "AUTH", "PAY")
- **Color**: Choose a color for highlighting
- **Priority**: Higher numbers take precedence (0-100)
- **Case Sensitive**: Toggle for exact case matching
- **Whole Word**: Match complete words only

### 3. Example Keywords to Add

Here are some recommended keywords for testing:

#### Authentication Keywords
- `verification` → TAG: AUTH, Color: Blue (#3B82F6), Priority: 10
- `code` → TAG: CODE, Color: Green (#10B981), Priority: 9, Whole Word: ✓
- `OTP` → TAG: OTP, Color: Purple (#8B5CF6), Priority: 10, Case Sensitive: ✓

#### Financial Keywords
- `payment` → TAG: PAY, Color: Yellow (#F59E0B), Priority: 7
- `transaction` → TAG: TXN, Color: Orange (#F97316), Priority: 7
- `balance` → TAG: BAL, Color: Cyan (#06B6D4), Priority: 6

#### Alert Keywords
- `URGENT` → TAG: ALERT, Color: Red (#DC2626), Priority: 10, Case Sensitive: ✓
- `warning` → TAG: WARN, Color: Yellow (#F59E0B), Priority: 8

### 4. View Highlighted Messages

1. Go back to the main dashboard (消息管理)
2. Messages containing your keywords will now show:
   - Highlighted text with the configured color
   - Tag labels next to matched keywords
   - Multiple tags if multiple keywords match

### 5. Test Messages

Here are some test messages that will trigger highlighting:

```
Your verification code is 123456. Please enter within 5 minutes.
→ Highlights: "verification" (AUTH), "code" (CODE)

URGENT: Payment of $100 failed. Check your account balance.
→ Highlights: "URGENT" (ALERT), "Payment" (PAY), "balance" (BAL)

Transaction successful! Your new balance is $500.
→ Highlights: "Transaction" (TXN), "balance" (BAL)
```

## 🔧 Advanced Features

### Priority System
When keywords overlap, the one with higher priority wins:
- "verification code" with priorities: verification=10, code=9
- Result: "verification" is highlighted (higher priority)

### Case Sensitivity
- `OTP` (case sensitive) - Only matches "OTP", not "otp" or "Otp"
- `payment` (case insensitive) - Matches "payment", "Payment", "PAYMENT"

### Whole Word Matching
- `code` (whole word) - Matches "code" but not "barcode" or "coded"
- `verification` (not whole word) - Matches in "verification" and "reverification"

### AI Analysis
Access keyword insights via the API:
```bash
POST /api/ai/analyze-keywords
{
  "phone_iccid": "optional-filter",
  "start_date": "2025-08-01",
  "end_date": "2025-08-04"
}
```

## 🔍 Troubleshooting

### Keywords Not Highlighting?
1. Ensure keywords are marked as "Active" (toggle switch)
2. Check case sensitivity settings
3. Verify whole word settings match your use case
4. Refresh the page after adding keywords

### Database Migration
If tables don't exist, run:
```bash
npx wrangler d1 execute sms-dashboard --remote --file=migrations/0010_add_keyword_tags.sql
```

## 📊 Performance

- Keywords are processed server-side during message upload
- Client-side fallback for real-time highlighting
- Efficient indexing for fast lookups
- Batch processing for multiple keywords

## 🎯 Use Cases

1. **Security Monitoring**: Highlight authentication codes and passwords
2. **Financial Tracking**: Tag payment and transaction messages
3. **Alert Management**: Identify urgent messages quickly
4. **Spam Detection**: Mark promotional messages
5. **Custom Workflows**: Create tags for your specific needs

Enjoy the new keyword highlighting feature! 🚀