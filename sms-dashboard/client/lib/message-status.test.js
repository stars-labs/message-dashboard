import { describe, expect, test } from 'bun:test';
import { getOutboundStatusMeta } from './message-status.js';

describe('outbound message status presentation', () => {
  test('uses explicit labels for every send state', () => {
    expect(getOutboundStatusMeta('sending').label).toBe('等待发送');
    expect(getOutboundStatusMeta('processing').label).toBe('发送中');
    expect(getOutboundStatusMeta('sent').label).toBe('已发送');
    expect(getOutboundStatusMeta('failed').label).toBe('发送失败');
    expect(getOutboundStatusMeta('unknown').label).toBe('结果未知');
  });

  test('exposes the stored failure as the status tooltip', () => {
    expect(getOutboundStatusMeta('failed', '+CMS ERROR: 350').title)
      .toBe('+CMS ERROR: 350');
  });
});
