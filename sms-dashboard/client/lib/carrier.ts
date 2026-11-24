import { textOr } from '../../shared/text.js';

interface CarrierRecord {
  carrier?: string | null;
  country?: string | null;
}

interface CarrierOption {
  key: string;
  label: string;
}

interface CarrierGroup {
  key: string;
  label: string;
  aliases: string[];
}

const CARRIER_GROUPS: readonly CarrierGroup[] = [
  { key: 'china-mobile', label: '移动', aliases: ['china mobile', 'cmcc', '中国移动', '移动'] },
  {
    key: 'china-telecom',
    label: '电信',
    aliases: ['china telecom', 'telecom', 'ctcc', '中国电信', '电信'],
  },
  { key: 'china-unicom', label: '联通', aliases: ['china unicom', 'unicom', '中国联通', '联通'] },
  {
    key: 'cmhk',
    label: 'CMHK',
    aliases: ['cmhk', 'china mobile hong kong', '中国移动香港', '中移香港', '香港移动'],
  },
  { key: 'm1', label: 'M1', aliases: ['m1'] },
  { key: 'singtel', label: 'Singtel', aliases: ['singtel'] },
  { key: 'starhub', label: 'StarHub', aliases: ['starhub'] },
];

function normalized(value: string | null | undefined): string {
  return textOr(value, '').trim().toLocaleLowerCase();
}

function isHongKong(country: string | null | undefined): boolean {
  return ['hk', 'hkg', 'hong kong', '香港'].includes(normalized(country));
}

export function carrierKey({ carrier, country }: CarrierRecord = {}): string {
  const candidate = normalized(carrier);
  if (!candidate) return '';
  const group = CARRIER_GROUPS.find((item) => item.aliases.includes(candidate));
  if (group?.key === 'china-mobile' && isHongKong(country)) return 'cmhk';
  return group?.key ?? candidate;
}

export function carrierLabel(record: CarrierRecord | null | undefined): string {
  const key = carrierKey(record ?? {});
  return (
    CARRIER_GROUPS.find((group) => group.key === key)?.label ?? textOr(record?.carrier, '').trim()
  );
}

export function buildCarrierOptions(records: readonly CarrierRecord[]): CarrierOption[] {
  const options = new Map<string, string>();
  for (const record of records) {
    const key = carrierKey(record);
    if (key && !options.has(key)) options.set(key, carrierLabel(record));
  }
  return [...options]
    .map(([key, label]) => ({ key, label }))
    .sort((left, right) =>
      left.label.localeCompare(right.label, 'zh-CN', {
        numeric: true,
        sensitivity: 'base',
      }),
    );
}
