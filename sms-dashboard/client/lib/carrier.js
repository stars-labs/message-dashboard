const CARRIER_GROUPS = [
  { key: 'china-mobile', label: '移动', aliases: ['china mobile', 'cmcc', '中国移动', '移动'] },
  { key: 'china-telecom', label: '电信', aliases: ['china telecom', 'telecom', 'ctcc', '中国电信', '电信'] },
  { key: 'china-unicom', label: '联通', aliases: ['china unicom', 'unicom', '中国联通', '联通'] },
  { key: 'cmhk', label: 'CMHK', aliases: ['cmhk', 'china mobile hong kong', '中国移动香港', '中移香港', '香港移动'] },
  { key: 'm1', label: 'M1', aliases: ['m1'] },
  { key: 'singtel', label: 'Singtel', aliases: ['singtel'] },
  { key: 'starhub', label: 'StarHub', aliases: ['starhub'] },
];

function normalized(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

export function carrierKey(value) {
  const candidate = normalized(value);
  if (!candidate) return '';
  return CARRIER_GROUPS.find((group) => group.aliases.includes(candidate))?.key || candidate;
}

export function carrierLabel(value) {
  const key = carrierKey(value);
  return CARRIER_GROUPS.find((group) => group.key === key)?.label || String(value || '').trim();
}

export function buildCarrierOptions(values) {
  const options = new Map();
  for (const value of values) {
    const key = carrierKey(value);
    if (key && !options.has(key)) options.set(key, carrierLabel(value));
  }
  return [...options].map(([key, label]) => ({ key, label }))
    .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN', {
      numeric: true,
      sensitivity: 'base',
    }));
}
