import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import DaemonHealthPanel from './DaemonHealthPanel.svelte';

afterEach(cleanup);

describe('DaemonHealthPanel v3 health contract', () => {
  test('shows delivery health without legacy task, modem, or queue fields', () => {
    const view = render(DaemonHealthPanel, {
      props: {
        status: {
          status: 'healthy',
          last_heartbeat: '2026-09-03 08:00:00',
          reasons: [],
          snapshot: {
            schema_version: 3,
            version: '8.0.1',
            uptime_seconds: 600,
            last_message_read_success_age_seconds: 4,
            last_upload_success_age_seconds: 75,
            queue: {
              pending: 2,
              in_flight: 1,
              dead_letter: 3,
              oldest_unacknowledged_age_seconds: 80,
            },
          },
        },
      },
    });

    expect(view.getByText('短信读取')).toBeTruthy();
    expect(view.getByText('消息上传')).toBeTruthy();
    expect(view.getByText('待处理')).toBeTruthy();
    expect(view.getByText('上传中')).toBeTruthy();
    expect(view.getByText('人工处理')).toBeTruthy();
    expect(view.getByText('最老积压')).toBeTruthy();
    expect(view.getByText('8.0.1')).toBeTruthy();
    expect(view.container.textContent).not.toContain('undefined');
    expect(view.container.textContent).not.toContain('暂无有效的任务健康报告');
    expect(view.container.textContent).not.toContain('Modem');
  });
});
