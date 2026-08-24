import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import PhoneList from './PhoneList.svelte';

afterEach(cleanup);

describe('PhoneList desktop panel', () => {
  test('clips its contents to the rounded panel boundary', () => {
    const view = render(PhoneList, { props: { phoneNumbers: [] } });

    expect(view.container.firstElementChild.classList).toContain('rounded-xl');
    expect(view.container.firstElementChild.classList).toContain('overflow-hidden');
  });
});
