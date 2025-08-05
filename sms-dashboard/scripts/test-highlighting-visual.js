#!/usr/bin/env node

// Visual test for keyword highlighting
import chalk from 'chalk';

// ANSI color codes for terminal output
const colors = {
  '#3B82F6': chalk.blue,      // Blue
  '#10B981': chalk.green,     // Green
  '#F59E0B': chalk.yellow,    // Amber
  '#EF4444': chalk.red,       // Red
  '#8B5CF6': chalk.magenta,   // Purple
  '#DC2626': chalk.redBright, // Bright Red
  '#F97316': chalk.hex('#F97316'), // Orange
  '#6B7280': chalk.gray,      // Gray
  '#14B8A6': chalk.cyan       // Teal
};

// Test keywords from database
const keywords = [
  { keyword: 'verification', tag: 'auth', color: '#3B82F6', priority: 10, case_sensitive: false, whole_word: false, is_active: true },
  { keyword: 'code', tag: 'otp', color: '#10B981', priority: 8, case_sensitive: false, whole_word: true, is_active: true },
  { keyword: 'OTP', tag: 'otp', color: '#F59E0B', priority: 9, case_sensitive: true, whole_word: false, is_active: true },
  { keyword: 'urgent', tag: 'alert', color: '#DC2626', priority: 10, case_sensitive: false, whole_word: false, is_active: true },
  { keyword: 'payment', tag: 'finance', color: '#8B5CF6', priority: 6, case_sensitive: false, whole_word: false, is_active: true }
];

// Test messages
const testMessages = [
  { content: 'Your verification code is 123456', from: 'AUTH-SVC' },
  { content: 'URGENT: Payment of $500 required', from: 'BANK' },
  { content: 'Your OTP for login: 789012', from: 'SECURE' },
  { content: 'Promo code SAVE20 expires soon!', from: 'SHOP' },
  { content: 'Transaction approved. New balance: $1,234.56', from: 'BANK' },
  { content: 'Password reset code: ABC123', from: 'SUPPORT' }
];

// Highlight function
function highlightMessage(message, keywords) {
  const activeKeywords = keywords.filter(k => k.is_active).sort((a, b) => b.priority - a.priority);
  const highlights = [];
  
  // Find all matches
  for (const keyword of activeKeywords) {
    const pattern = keyword.whole_word 
      ? `\\b${escapeRegex(keyword.keyword)}\\b`
      : escapeRegex(keyword.keyword);
    
    const flags = keyword.case_sensitive ? 'g' : 'gi';
    const regex = new RegExp(pattern, flags);
    
    let match;
    while ((match = regex.exec(message)) !== null) {
      highlights.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        color: keyword.color,
        tag: keyword.tag
      });
    }
  }
  
  // Remove overlaps
  const filtered = highlights.sort((a, b) => a.start - b.start)
    .filter((h, i, arr) => i === 0 || h.start >= arr[i-1].end);
  
  // Build highlighted string
  let result = '';
  let lastEnd = 0;
  
  for (const highlight of filtered) {
    result += message.slice(lastEnd, highlight.start);
    const colorFn = colors[highlight.color] || chalk.white;
    result += colorFn.bold(highlight.text) + chalk.gray(` [${highlight.tag}]`);
    lastEnd = highlight.end;
  }
  
  result += message.slice(lastEnd);
  return result;
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Run visual test
console.log(chalk.cyan.bold('\n=== SMS Dashboard Keyword Highlighting Visual Test ===\n'));

console.log(chalk.white.bold('Active Keywords:'));
keywords.forEach(k => {
  const colorFn = colors[k.color] || chalk.white;
  console.log(`  • ${colorFn('■')} "${k.keyword}" → ${k.tag} (priority: ${k.priority})`);
});

console.log(chalk.white.bold('\nTest Messages:\n'));

testMessages.forEach((msg, index) => {
  console.log(chalk.gray(`[${msg.from}]`));
  console.log(`Original: ${msg.content}`);
  console.log(`Highlighted: ${highlightMessage(msg.content, keywords)}`);
  console.log('');
});

console.log(chalk.green.bold('✓ Keyword highlighting test complete!\n'));