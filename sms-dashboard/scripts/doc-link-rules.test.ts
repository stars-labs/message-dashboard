import { describe, expect, test } from 'bun:test';
import { brokenDocLinks, repoPaths } from './doc-link-rules.ts';

const tracked = repoPaths([
  'AGENTS.md',
  'docs/deployment.md',
  'docs/architecture/README.md',
  'docs/architecture/flow.svg',
  'sms-dashboard/AGENTS.md',
  'sms-dashboard/server/handlers/messages.ts',
]);

/** Built at runtime so check-doc-links does not report this file's own fixtures. */
function missingDoc(name: string): string {
  return `docs/${name}`;
}

function broken(path: string, text: string): string[] {
  return brokenDocLinks([{ path, text }], tracked);
}

describe('brokenDocLinks', () => {
  test('accepts relative links to files and directories that exist', () => {
    const text = [
      '[deploy](docs/deployment.md)',
      '[arch](docs/architecture/)',
      '![flow](docs/architecture/flow.svg "Flow")',
      '[dashboard](sms-dashboard/AGENTS.md#development)',
    ].join('\n');

    expect(broken('AGENTS.md', text)).toEqual([]);
  });

  test('resolves a link against the directory of the file that holds it', () => {
    expect(broken('sms-dashboard/AGENTS.md', '[deploy](../docs/deployment.md)')).toEqual([]);
    expect(broken('sms-dashboard/AGENTS.md', '[deploy](docs/deployment.md)')).toEqual([
      'sms-dashboard/AGENTS.md: docs/deployment.md',
    ]);
  });

  test('resolves a leading slash against the repository root', () => {
    expect(broken('sms-dashboard/AGENTS.md', '[deploy](/docs/deployment.md)')).toEqual([]);
  });

  test('rejects a link to a missing file or one outside the repository', () => {
    const text = `[api](${missingDoc('api/README.md')})\n[up](../outside.md)`;

    expect(broken('AGENTS.md', text)).toEqual([
      `AGENTS.md: ${missingDoc('api/README.md')}`,
      'AGENTS.md: ../outside.md',
    ]);
  });

  test('ignores external links, bare anchors and code', () => {
    const text = [
      '[site](https://sexy.itoken.world) [mail](mailto:ops@example.com) [top](#top)',
      '`[not](a-link.md)`',
      '```md',
      '[not](a-link-either.md)',
      '```',
    ].join('\n');

    expect(broken('AGENTS.md', text)).toEqual([]);
  });

  test('decodes percent-encoded targets', () => {
    expect(broken('AGENTS.md', '[deploy](docs/deploy%6Dent.md)')).toEqual([]);
  });

  test('checks repo-root docs/ paths named in any file, code comments included', () => {
    const files = [
      {
        path: 'sms-dashboard/server/handlers/messages.ts',
        text: `// never body.recipient (${missingDoc('security.md')} finding 3)\n// see docs/deployment.md`,
      },
      { path: 'AGENTS.md', text: `sms-dashboard/${missingDoc('API.md')} is not a root path` },
    ];

    expect(brokenDocLinks(files, tracked)).toEqual([
      `sms-dashboard/server/handlers/messages.ts: ${missingDoc('security.md')}`,
    ]);
  });
});
