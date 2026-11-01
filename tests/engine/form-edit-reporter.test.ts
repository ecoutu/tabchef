import { describe, expect, it, vi } from 'vitest';
import { createFormEditReporter } from '../../src/engine/form-edit-reporter';

describe('createFormEditReporter', () => {
  it('reports once per page, again after a same-document URL change', () => {
    let href = 'https://a.com/1';
    const send = vi.fn();
    const onInput = createFormEditReporter(() => href, send);
    onInput();
    onInput();
    expect(send).toHaveBeenCalledTimes(1);
    href = 'https://a.com/1#next';
    onInput();
    onInput();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
