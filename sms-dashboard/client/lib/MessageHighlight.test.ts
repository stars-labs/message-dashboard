import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import MessageHighlight from './MessageHighlight.svelte';

afterEach(cleanup);

const otp = { keyword: 'code', tag: 'OTP', color: '#FF0000', case_sensitive: 0, whole_word: 0 };

describe('MessageHighlight', () => {
  test('marks each keyword match and keeps the text around it', () => {
    const { container } = render(MessageHighlight, {
      props: { content: 'your code is 1234', keywords: [otp] },
    });

    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe('code');
    expect(marks[0]?.getAttribute('title')).toBe('OTP');
    expect(container.textContent).toBe('your code is 1234');
  });

  test('renders the text unmarked when nothing matches', () => {
    const { container } = render(MessageHighlight, {
      props: { content: 'nothing here', keywords: [otp] },
    });

    expect(container.querySelector('mark')).toBeNull();
    expect(container.textContent).toBe('nothing here');
  });

  test('never renders message text as markup', () => {
    const { container } = render(MessageHighlight, {
      props: { content: '<img src=x onerror=alert(1)> code', keywords: [otp] },
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
