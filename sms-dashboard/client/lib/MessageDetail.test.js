// Run with: bun run test client/lib/MessageDetail.test.js
// (bun run, not bare `bun test` — package.json adds --conditions=browser, without
// which Svelte resolves its server build and every render() throws.)
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import MessageDetail from './MessageDetail.svelte';

// A body long enough to exercise the reason this drawer exists. Production's
// longest message is 776 characters; a third of all messages exceed the two
// lines a list row can show.
const LONG_BODY = '【心级服务 让爱连接】尊敬的客户，感谢您长期以来的支持，'
  + '中国移动特开展“请您评价”调研活动，邀请您参与2道问题调研，期待您的10分满意！'.repeat(8);

const received = (fields = {}) => ({
  id: 'msg-1',
  type: 'received',
  content: '【抖音】您的验证码是38291，请在15分钟内使用。',
  phone_number: '100860011575',
  phone_iccid: '898600520121F0517883',
  phone_sim_index: 52,
  phone_country: 'CN',
  phone_carrier: 'China Mobile',
  display_phone_number: '+8613810113243',
  verification_code: '38291',
  filter_status: 'clean',
  filter_rule_id: null,
  timestamp: '2026-08-26 04:01:20',
  ...fields,
});

afterEach(cleanup);

describe('MessageDetail', () => {
  test('renders the full body without clamping it', () => {
    const { container, getByText } = render(MessageDetail, {
      props: { message: received({ content: LONG_BODY, verification_code: null }) },
    });

    // The whole body is present, not an ellipsised prefix.
    expect(getByText(LONG_BODY)).toBeTruthy();
    // And nothing in the drawer re-imposes the row's two-line clamp.
    expect(container.querySelector('.line-clamp-2')).toBeNull();
  });

  test('reports the body length so a long message is obviously long', () => {
    const { getByText } = render(MessageDetail, {
      props: { message: received({ content: LONG_BODY }) },
    });
    expect(getByText(`${LONG_BODY.length} 字符`)).toBeTruthy();
  });

  test('shows the verification code when there is one', () => {
    const { getByText } = render(MessageDetail, { props: { message: received() } });
    expect(getByText('验证码')).toBeTruthy();
    expect(getByText('38291')).toBeTruthy();
  });

  test('omits the verification-code section when there is none', () => {
    const { queryByText } = render(MessageDetail, {
      props: { message: received({ verification_code: null }) },
    });
    expect(queryByText('验证码')).toBeNull();
  });

  test('shows the local card and the counterparty', () => {
    const { getByText } = render(MessageDetail, { props: { message: received() } });
    expect(getByText(/S52/)).toBeTruthy();
    expect(getByText(/来自 100860011575/)).toBeTruthy();
  });

  test('closes on the close button', async () => {
    let closed = false;
    const { getAllByRole } = render(MessageDetail, {
      props: { message: received(), onClose: () => { closed = true; } },
    });
    await fireEvent.click(getAllByRole('button', { name: '关闭' })[0]);
    expect(closed).toBe(true);
  });

  test('closes on Escape', async () => {
    let closed = false;
    render(MessageDetail, {
      props: { message: received(), onClose: () => { closed = true; } },
    });
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(closed).toBe(true);
  });

  // Mirrors BalanceQueryDetail's positioning so the mobile tab bar never covers
  // the drawer's own controls.
  test('leaves room for the mobile tab bar', () => {
    const { container } = render(MessageDetail, { props: { message: received() } });
    expect(container.querySelector('.bottom-\\[73px\\]')).toBeTruthy();
  });

  test('names the rule that filtered a hidden message', () => {
    const { getByText } = render(MessageDetail, {
      props: {
        message: received({ filter_status: 'filtered', filter_rule_id: 35 }),
        filterRules: [{ id: 35, pattern: '心级服务', note: '中国移动服务营销群发' }],
      },
    });
    expect(getByText('已过滤: 中国移动服务营销群发')).toBeTruthy();
  });

  test('shows why an outbound message failed', () => {
    const { getByText } = render(MessageDetail, {
      props: {
        message: received({
          type: 'sent',
          status: 'failed',
          error_message: 'CMS ERROR 500',
          recipient: '+6580286158',
          verification_code: null,
        }),
      },
    });
    expect(getByText('发送失败')).toBeTruthy();
    expect(getByText('CMS ERROR 500')).toBeTruthy();
    expect(getByText(/发送至 \+6580286158/)).toBeTruthy();
  });

  test('highlights configured keywords as real elements', () => {
    const { container } = render(MessageDetail, {
      props: {
        message: received({ content: '您的抖音验证码是38291' }),
        keywords: [{ keyword: '抖音', tag: '抖音', color: '#3B82F6', is_active: true }],
      },
    });
    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0].textContent).toBe('抖音');
  });

  // SMS content is fully attacker-controlled: anyone knowing a SIM's number can
  // send arbitrary text. A previous {@html} implementation was an XSS vector
  // (docs/SECURITY-REVIEW.md finding 2), so markup must arrive as inert text.
  test('does not interpret markup in the message body', () => {
    const payload = '<img src=x onerror="alert(1)">恶意内容';
    const { container, getByText } = render(MessageDetail, {
      props: { message: received({ content: payload, verification_code: null }) },
    });
    expect(container.querySelector('img')).toBeNull();
    expect(getByText(payload)).toBeTruthy();
  });

  test('renders nothing when no message is selected', () => {
    const { container } = render(MessageDetail, { props: { message: null } });
    expect(container.querySelector('section')).toBeNull();
  });
});
