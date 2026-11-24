import { SvelteDate, SvelteSet } from 'svelte/reactivity';
import * as v from 'valibot';
import { formatCardNumber } from '../card-number.js';
import type { ApiMessage } from '../../../shared/api/messages.js';
import type { Phone } from '../../../shared/api/phones.js';
import { parseJson, type Parsed } from '../../../shared/parse-json.js';
import { textOr } from '../../../shared/text.js';

export interface SenderPhone extends Pick<
  Phone,
  'iccid' | 'number' | 'status' | 'carrier' | 'operator' | 'sim_index'
> {
  flag: string;
}

export interface SentMessage {
  phone_iccid: string;
  phoneNumber: string;
  recipient: string;
  content: string;
  timestamp: Date;
  type: 'sent';
  status: 'sending';
}

interface ComposerInputs {
  selectedPhone: Pick<Phone, 'iccid'> | null;
  phoneNumbers: readonly SenderPhone[];
  messages: readonly Pick<ApiMessage, 'type' | 'recipient'>[];
  onmessagesent: ((message: SentMessage) => Promise<unknown>) | null;
}

const RecipientList = v.array(v.string());
const Draft = v.nullable(
  v.partial(
    v.object({
      recipientNumber: v.string(),
      recipientSIM: v.string(),
      messageContent: v.string(),
      selectedCountryCode: v.string(),
      selectedSimDisplay: v.string(),
    }),
  ),
);

const DRAFT_KEY = 'sms-dashboard:send-draft';

export const countryCodes = [
  { code: '', country: '不加区号', short: 'NONE' },
  { code: '+65', country: '🇸🇬 Singapore', short: 'SG' },
  { code: '+86', country: '🇨🇳 China', short: 'CN' },
  { code: '+1', country: '🇺🇸 USA/Canada', short: 'US' },
  { code: '+44', country: '🇬🇧 UK', short: 'UK' },
  { code: '+81', country: '🇯🇵 Japan', short: 'JP' },
  { code: '+82', country: '🇰🇷 South Korea', short: 'KR' },
  { code: '+60', country: '🇲🇾 Malaysia', short: 'MY' },
  { code: '+66', country: '🇹🇭 Thailand', short: 'TH' },
  { code: '+62', country: '🇮🇩 Indonesia', short: 'ID' },
  { code: '+63', country: '🇵🇭 Philippines', short: 'PH' },
  { code: '+84', country: '🇻🇳 Vietnam', short: 'VN' },
  { code: '+91', country: '🇮🇳 India', short: 'IN' },
  { code: '+61', country: '🇦🇺 Australia', short: 'AU' },
  { code: '+49', country: '🇩🇪 Germany', short: 'DE' },
  { code: '+33', country: '🇫🇷 France', short: 'FR' },
];

export const messageTemplates = [
  { name: '验证码模板', content: '您的验证码是：123456，有效期5分钟。' },
  { name: '通知模板', content: '尊敬的用户，您的订单已发货，请注意查收。' },
  { name: '提醒模板', content: '温馨提醒：您的账户余额不足，请及时充值。' },
  { name: '营销模板', content: '限时优惠！全场商品8折，快来选购吧！' },
];

function formatSimDisplay(phone: SenderPhone) {
  const number =
    phone.number && phone.number !== 'null'
      ? phone.number
      : phone.iccid
        ? `ICCID: ${phone.iccid.slice(-6)}`
        : 'Unknown';
  const operator = phone.carrier ? ` - ${phone.carrier}` : '';
  return `${formatCardNumber(phone.sim_index)} · ${phone.flag || ''} ${number}${operator}`.trim();
}

function parseStoredRecipients(): Parsed<string[]> {
  return parseJson(textOr(localStorage.getItem('recipientHistory'), '[]'), RecipientList);
}

export class ComposerState {
  recipientNumber = $state('');
  recipientSIM = $state('');
  messageContent = $state('');
  sendingStatus = $state('');
  showRecipientHistory = $state(false);
  recipientSearch = $state('');
  simSearch = $state('');
  showSimDropdown = $state(false);
  selectedSimDisplay = $state('');
  selectedCountryCode = $state('+65');
  showCountryDropdown = $state(false);
  draftReady = $state(false);
  recipientHistory = $state<string[]>([]);

  readonly #inputs: () => ComposerInputs;

  filteredRecipients = $derived(
    this.recipientHistory.filter(
      (num) => num.includes(this.recipientSearch) || this.recipientSearch === '',
    ),
  );

  availablePhones = $derived.by(() =>
    this.#inputs().phoneNumbers.filter(
      (p) =>
        p.iccid &&
        (p.status === 'online' ||
          p.status === 'registered' ||
          !p.status ||
          (p.status !== 'offline' && p.status !== 'error' && p.status !== 'sim-missing')),
    ),
  );

  filteredSims = $derived(
    this.availablePhones.filter((phone) => {
      if (!this.simSearch) return true;
      const searchLower = this.simSearch.toLowerCase();
      const phoneDisplay = formatSimDisplay(phone).toLowerCase();
      return phoneDisplay.includes(searchLower) || phone.iccid.toLowerCase().includes(searchLower);
    }),
  );

  constructor(inputs: () => ComposerInputs) {
    this.#inputs = inputs;
    this.recipientHistory = [
      ...new SvelteSet(
        inputs().messages.flatMap((msg) =>
          msg.type === 'sent' && msg.recipient ? [msg.recipient] : [],
        ),
      ),
    ].slice(0, 20);
  }

  getFullPhoneNumber() {
    const num = this.recipientNumber.trim();
    if (num.startsWith('+')) {
      return num;
    }
    // Optional so carrier short codes (for example 10010) go out unchanged.
    if (!this.selectedCountryCode) return num;
    return `${this.selectedCountryCode}${num}`;
  }

  syncSelectedPhone() {
    const selectedPhone = this.#inputs().selectedPhone;
    if (selectedPhone) {
      this.recipientSIM = selectedPhone.iccid;
      const phone = this.availablePhones.find((p) => p.iccid === selectedPhone.iccid);
      if (phone) {
        this.selectedSimDisplay = formatSimDisplay(phone);
      }
    }
  }

  async handleSend() {
    if (!this.recipientNumber || !this.recipientSIM || !this.messageContent) {
      this.sendingStatus = 'validation-error';
      setTimeout(() => (this.sendingStatus = ''), 3000);
      return;
    }

    this.sendingStatus = 'sending';

    const fullPhoneNumber = this.getFullPhoneNumber();

    const stored = parseStoredRecipients();
    if (!stored.ok) throw new Error(stored.error);
    const storedRecipients = stored.value;
    if (!storedRecipients.includes(fullPhoneNumber)) {
      storedRecipients.unshift(fullPhoneNumber);
      localStorage.setItem('recipientHistory', JSON.stringify(storedRecipients.slice(0, 50)));
    }

    const sentMessage: SentMessage = {
      phone_iccid: this.recipientSIM,
      phoneNumber: fullPhoneNumber,
      recipient: fullPhoneNumber,
      content: this.messageContent,
      timestamp: new SvelteDate(),
      type: 'sent',
      status: 'sending',
    };

    try {
      // App owns the HTTP request. Keep the draft until the API accepts it.
      const onmessagesent = this.#inputs().onmessagesent;
      if (!onmessagesent) throw new Error('发送服务不可用');
      await onmessagesent(sentMessage);
      this.sendingStatus = 'success';
      this.messageContent = '';
    } catch (error) {
      console.error('Failed to send message:', error);
      this.sendingStatus = 'send-error';
    }

    setTimeout(() => {
      this.sendingStatus = '';
    }, 2000);
  }

  selectRecipient(number: string) {
    this.recipientNumber = number;
    this.showRecipientHistory = false;
    this.recipientSearch = '';
  }

  selectSim(phone: SenderPhone) {
    this.recipientSIM = phone.iccid;
    this.selectedSimDisplay = formatSimDisplay(phone);
    this.showSimDropdown = false;
    this.simSearch = '';
  }

  insertTemplate(template: string) {
    this.messageContent = template;
  }

  selectCountryCode(code: string) {
    this.selectedCountryCode = code;
    this.showCountryDropdown = false;
  }

  loadRecipientHistory() {
    const stored = parseStoredRecipients();
    if (!stored.ok) {
      localStorage.removeItem('recipientHistory');
      return;
    }
    if (stored.value.length > 0) this.recipientHistory.push(...stored.value);
  }

  restoreDraft() {
    const parsed = parseJson(textOr(sessionStorage.getItem(DRAFT_KEY), 'null'), Draft);
    if (!parsed.ok) {
      sessionStorage.removeItem(DRAFT_KEY);
      return;
    }
    const draft = parsed.value;
    if (draft) {
      this.recipientNumber = textOr(draft.recipientNumber, '');
      this.recipientSIM = textOr(draft.recipientSIM, this.recipientSIM);
      this.messageContent = textOr(draft.messageContent, '');
      this.selectedCountryCode = draft.selectedCountryCode ?? '+65';
      const restoredSim = this.availablePhones.find((phone) => phone.iccid === this.recipientSIM);
      this.selectedSimDisplay = restoredSim
        ? formatSimDisplay(restoredSim)
        : textOr(draft.selectedSimDisplay, this.selectedSimDisplay);
    }
  }

  persistDraft() {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        recipientNumber: this.recipientNumber,
        recipientSIM: this.recipientSIM,
        messageContent: this.messageContent,
        selectedCountryCode: this.selectedCountryCode,
        selectedSimDisplay: this.selectedSimDisplay,
      }),
    );
  }

  handleClickOutside = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('.recipient-input-container')) {
      this.showRecipientHistory = false;
    }
    if (!target.closest('.sim-input-container')) {
      this.showSimDropdown = false;
    }
    if (!target.closest('.country-code-container')) {
      this.showCountryDropdown = false;
    }
  };
}
