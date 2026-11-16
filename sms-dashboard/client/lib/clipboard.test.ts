import { afterEach, describe, expect, test } from 'bun:test';
import { copyCode } from './clipboard.js';

const NavigatorPrototype = Navigator.prototype;
const exposed = Object.getOwnPropertyDescriptor(NavigatorPrototype, 'clipboard');

function setClipboard(writeText: Clipboard['writeText']): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
  if (exposed) Object.defineProperty(NavigatorPrototype, 'clipboard', exposed);
});

describe('copyCode', () => {
  test('writes the text and reports success', async () => {
    const written: string[] = [];
    setClipboard((text) => {
      written.push(text);
      return Promise.resolve();
    });

    expect(await copyCode('483920')).toBe(true);
    expect(written).toEqual(['483920']);
  });

  test('reports failure when the browser refuses the write', async () => {
    setClipboard(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));

    expect(await copyCode('483920')).toBe(false);
  });

  test('reports failure outside a secure context, where the clipboard is not exposed', async () => {
    Reflect.deleteProperty(NavigatorPrototype, 'clipboard');

    expect('clipboard' in navigator).toBe(false);
    expect(await copyCode('483920')).toBe(false);
  });
});
