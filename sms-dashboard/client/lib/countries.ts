import { textOr } from '../../shared/text.js';

interface Country {
  code: string;
  name: string;
  flag: string;
}

/** A phone row or a raw number, either accepted by the inference helper. */
type PhoneLike =
  | string
  | {
      number?: string | null;
      country?: string | null;
      mapped_country?: string | null;
    }
  | null
  | undefined;

export const COUNTRIES: readonly Country[] = [
  { code: 'CN', name: '中国', flag: '🇨🇳' },
  { code: 'HK', name: '香港', flag: '🇭🇰' },
  { code: 'SG', name: '新加坡', flag: '🇸🇬' },
  { code: 'US', name: '美国', flag: '🇺🇸' },
  { code: 'UK', name: '英国', flag: '🇬🇧' },
  { code: 'JP', name: '日本', flag: '🇯🇵' },
  { code: 'KR', name: '韩国', flag: '🇰🇷' },
  { code: 'MY', name: '马来西亚', flag: '🇲🇾' },
  { code: 'TH', name: '泰国', flag: '🇹🇭' },
  { code: 'VN', name: '越南', flag: '🇻🇳' },
  { code: 'PH', name: '菲律宾', flag: '🇵🇭' },
  { code: 'ID', name: '印度尼西亚', flag: '🇮🇩' },
  { code: 'IN', name: '印度', flag: '🇮🇳' },
  { code: 'AU', name: '澳大利亚', flag: '🇦🇺' },
  { code: 'NZ', name: '新西兰', flag: '🇳🇿' },
  { code: 'CA', name: '加拿大', flag: '🇨🇦' },
  { code: 'DE', name: '德国', flag: '🇩🇪' },
  { code: 'FR', name: '法国', flag: '🇫🇷' },
  { code: 'IT', name: '意大利', flag: '🇮🇹' },
  { code: 'ES', name: '西班牙', flag: '🇪🇸' },
  { code: 'RU', name: '俄罗斯', flag: '🇷🇺' },
  { code: 'BR', name: '巴西', flag: '🇧🇷' },
  { code: 'MX', name: '墨西哥', flag: '🇲🇽' },
];

export const COUNTRY_FILTER_TABS: readonly Country[] = [
  { code: 'all', name: '全部', flag: '🌍' },
  { code: 'CN', name: '中国', flag: '🇨🇳' },
  { code: 'HK', name: '香港', flag: '🇭🇰' },
  { code: 'SG', name: '新加坡', flag: '🇸🇬' },
];

const COUNTRY_BY_CODE = new Map(COUNTRIES.map((country) => [country.code, country]));

export function getCountryFlag(code: string | null | undefined): string {
  return (code ? COUNTRY_BY_CODE.get(code)?.flag : undefined) ?? '🌍';
}

export function getCountryName(code: string | null | undefined): string {
  return (code ? COUNTRY_BY_CODE.get(code)?.name : undefined) ?? code ?? '';
}

export function inferCountryFromNumber(numberOrPhone: PhoneLike): string | null {
  // Accept either a phone object or a raw number string
  if (typeof numberOrPhone === 'object' && numberOrPhone !== null) {
    const stated = textOr(numberOrPhone.country, textOr(numberOrPhone.mapped_country, null));
    if (stated !== null) return stated;
    numberOrPhone = numberOrPhone.number;
  }

  if (!numberOrPhone) return null;
  const num = numberOrPhone;

  if (num.startsWith('86') || num.startsWith('+86') || (num.startsWith('1') && num.length === 11))
    return 'CN';
  if (num.startsWith('852') || num.startsWith('+852') || num.startsWith('00852')) return 'HK';
  if (
    num.startsWith('65') ||
    num.startsWith('+65') ||
    (num.length === 8 && (num.startsWith('8') || num.startsWith('9')))
  )
    return 'SG';
  if (num.startsWith('+1') || (num.length === 10 && !num.startsWith('1'))) return 'US';
  if (num.startsWith('81') || num.startsWith('+81')) return 'JP';
  if (num.startsWith('82') || num.startsWith('+82')) return 'KR';
  if (num.startsWith('60') || num.startsWith('+60')) return 'MY';
  if (num.startsWith('66') || num.startsWith('+66')) return 'TH';

  return null;
}

export function getPhoneFlag(phone: PhoneLike): string {
  const code = typeof phone === 'string' ? phone : inferCountryFromNumber(phone);
  return code ? getCountryFlag(code) : '📱';
}

export function getCarrierColor(carrier: string | null | undefined): string {
  if (!carrier) return '';
  const c = carrier.toUpperCase();

  if (c.includes('CMCC') || c.includes('中国移动') || c.includes('CHINA MOBILE'))
    return 'bg-blue-50 text-blue-700 border border-blue-200';
  if (c.includes('UNICOM') || c.includes('中国联通') || c.includes('CHINA UNICOM'))
    return 'bg-orange-50 text-orange-700 border border-orange-200';
  if (c.includes('TELECOM') || c.includes('中国电信') || c.includes('CHINA TELECOM'))
    return 'bg-red-50 text-red-700 border border-red-200';
  if (c.includes('CMHK') || c.includes('香港移动'))
    return 'bg-purple-50 text-purple-700 border border-purple-200';
  if (c.includes('SINGTEL')) return 'bg-teal-50 text-teal-700 border border-teal-200';
  if (c.includes('STARHUB')) return 'bg-indigo-50 text-indigo-700 border border-indigo-200';
  if (c.includes('M1') || c.includes('SGP-M1'))
    return 'bg-green-50 text-green-700 border border-green-200';

  return 'bg-stone-100 text-stone-600 border border-stone-200';
}
