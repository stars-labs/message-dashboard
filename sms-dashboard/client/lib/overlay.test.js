import { afterEach, describe, expect, test } from 'bun:test';
import { overlay } from './overlay.js';

function node() {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

afterEach(() => {
  document.body.innerHTML = '';
});

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

describe('overlay dismiss behaviour', () => {
  test('Escape closes the overlay', () => {
    const closed = [];
    const handle = overlay(node(), { onClose: () => closed.push(true) });

    pressEscape();

    expect(closed).toHaveLength(1);
    handle.destroy();
  });

  test('other keys do nothing', () => {
    const closed = [];
    const handle = overlay(node(), { onClose: () => closed.push(true) });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));

    expect(closed).toHaveLength(0);
    handle.destroy();
  });

  test('a destroyed overlay stops listening', () => {
    const closed = [];
    overlay(node(), { onClose: () => closed.push(true) }).destroy();

    pressEscape();

    expect(closed).toHaveLength(0);
  });

  test('the overlay is made focusable and focus returns to the opener', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const element = node();
    const handle = overlay(element);
    expect(element.getAttribute('tabindex')).toBe('-1');

    handle.destroy();
    expect(document.activeElement).toBe(opener);
  });

  test('an updated handler replaces the old one', () => {
    const first = [];
    const second = [];
    const element = node();
    const handle = overlay(element, { onClose: () => first.push(true) });

    handle.update({ onClose: () => second.push(true) });
    pressEscape();

    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
    handle.destroy();
  });
});
