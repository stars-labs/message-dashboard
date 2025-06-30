export const phoneNumbers = Array.from({ length: 95 }, (_, i) => {
  const id = i + 1;
  const countries = [
    { code: 'CN', name: '中国', prefix: '+86', flag: '🇨🇳' },
    { code: 'HK', name: '香港', prefix: '+852', flag: '🇭🇰' },
    { code: 'SG', name: '新加坡', prefix: '+65', flag: '🇸🇬' }
  ];
  
  const country = countries[Math.floor(Math.random() * countries.length)];
  const carriers = {
    CN: ['中国移动', '中国联通', '中国电信'],
    HK: ['中国移动香港', 'CSL', '3HK'],
    SG: ['Singtel', 'StarHub', 'M1']
  };
  
  const carrier = carriers[country.code][Math.floor(Math.random() * carriers[country.code].length)];
  const status = Math.random() > 0.1 ? 'online' : (Math.random() > 0.5 ? 'offline' : 'error');
  
  const numberSuffix = String(10000000 + Math.floor(Math.random() * 89999999));
  const phoneNumber = country.code === 'CN' 
    ? `${country.prefix}13${numberSuffix}` 
    : `${country.prefix}${numberSuffix}`;
  
  return {
    id: `EC20-${String(id).padStart(2, '0')}`,
    number: phoneNumber,
    country: country.code,
    countryName: country.name,
    flag: country.flag,
    carrier,
    status,
    lastActive: new Date(Date.now() - Math.floor(Math.random() * 3600000))
  };
});

const sources = [
  '淘宝', '京东', '微信', '支付宝', 'WhatsApp', 'Telegram', 
  '美团', '抖音', '小红书', 'Google', 'Facebook', 'Instagram',
  '银行', '12306', '携程', '滴滴', 'Uber', 'Grab', 'Tron', 'TRON'
];

const verificationCodePatterns = [
  /验证码[:：]\s*(\d{4,6})/,
  /您的验证码是\s*(\d{4,6})/,
  /\[.*?\]\s*(\d{4,6})/,
  /code[:：]\s*(\d{4,6})/i,
  /OTP[:：]\s*(\d{4,6})/i,
  /verification code[:：]\s*(\d{4,6})/i,
  /(\d{4,6})\s*是您的.*?验证码/,
  /Your.*?code is[:：]?\s*(\d{4,6})/i
];

export function extractVerificationCode(content) {
  for (const pattern of verificationCodePatterns) {
    const match = content.match(pattern);
    if (match) {
      return match[1];
    }
  }
  
  const simpleMatch = content.match(/\b(\d{4,6})\b/);
  if (simpleMatch) {
    return simpleMatch[1];
  }
  
  return null;
}

const messageTemplates = [
  { source: '淘宝', template: '[淘宝] 验证码{code}，您正在登录，请勿告诉他人。' },
  { source: '京东', template: '[京东] 验证码：{code}，请在5分钟内完成验证。' },
  { source: '微信', template: '[微信] {code}是您的登录验证码，请在2分钟内使用。' },
  { source: '支付宝', template: '[支付宝] 您的验证码是{code}，有效期10分钟。' },
  { source: 'WhatsApp', template: 'Your WhatsApp code: {code}. Do not share this code.' },
  { source: 'Telegram', template: 'Telegram code {code}. Do not give this code to anyone.' },
  { source: '美团', template: '[美团] 验证码{code}，用于手机号验证，5分钟内有效。' },
  { source: '抖音', template: '[抖音] 验证码{code}，用于更改密码，请勿泄露。' },
  { source: '小红书', template: '[小红书] 您的验证码是：{code}，请勿向他人泄露。' },
  { source: 'Google', template: 'G-{code} is your Google verification code.' },
  { source: 'Facebook', template: '{code} is your Facebook confirmation code.' },
  { source: 'Instagram', template: '{code} is your Instagram code. Do not share it.' },
  { source: '银行', template: '[工商银行] 验证码：{code}，您正在进行转账操作。' },
  { source: '12306', template: '[铁路12306] 验证码：{code}，您正在购买火车票。' },
  { source: '携程', template: '[携程旅行] 验证码{code}，您正在预订酒店。' },
  { source: '滴滴', template: '[滴滴出行] 验证码：{code}，请在3分钟内输入。' },
  { source: 'Uber', template: 'Your Uber code is {code}. Never share this code.' },
  { source: 'Grab', template: 'Your Grab verification code is {code}.' },
  { source: 'Tron', template: '[Tron] Your verification code is {code}. Valid for 5 minutes.' },
  { source: 'TRON', template: '[TRON Network] Security code: {code}. Do not share with anyone.' }
];

export const messages = [];

const now = Date.now();
for (let i = 0; i < 500; i++) {
  const phone = phoneNumbers[Math.floor(Math.random() * phoneNumbers.length)];
  const template = messageTemplates[Math.floor(Math.random() * messageTemplates.length)];
  const code = String(100000 + Math.floor(Math.random() * 899999)).slice(0, Math.random() > 0.5 ? 6 : 4);
  const content = template.template.replace('{code}', code);
  
  messages.push({
    id: `msg-${i + 1}`,
    phoneId: phone.id,
    phoneNumber: phone.number,
    sender: template.source,
    content,
    timestamp: new Date(now - Math.floor(Math.random() * 86400000 * 7)), // 最近7天
    verificationCode: extractVerificationCode(content),
    source: template.source
  });
}

messages.sort((a, b) => b.timestamp - a.timestamp);

export function getMessagesByPhone(phoneId) {
  return messages.filter(msg => msg.phoneId === phoneId);
}

export function getMessagesBySource(source) {
  return messages.filter(msg => msg.source === source);
}

export function getRecentMessages(limit = 50) {
  return messages.slice(0, limit);
}

export function getMessageStats() {
  const stats = {
    total: messages.length,
    today: messages.filter(msg => {
      const today = new Date();
      const msgDate = new Date(msg.timestamp);
      return msgDate.toDateString() === today.toDateString();
    }).length,
    bySource: {},
    byCountry: {}
  };
  
  messages.forEach(msg => {
    stats.bySource[msg.source] = (stats.bySource[msg.source] || 0) + 1;
    
    const phone = phoneNumbers.find(p => p.id === msg.phoneId);
    if (phone) {
      stats.byCountry[phone.country] = (stats.byCountry[phone.country] || 0) + 1;
    }
  });
  
  return stats;
}