// bun run audit: fails on any npm advisory not accepted below, and on an accepted one
// no longer reported. Needs the network (the advisory database).
import { join } from 'node:path';
import * as v from 'valibot';
import { parseJson } from '../shared/parse-json.ts';
import { auditViolations, type Advisory } from './audit-rules.ts';

// Reachable only from build, lint and packaging tools on this repository's own files,
// and pinned by them at their latest versions (eslint, tailwindcss 3, electron-builder).
const BUILD_TOOL_PATTERNS =
  'The patterns come from our own eslint, tailwind and electron-builder config, never from outside input.';
const ACCEPTED: Record<string, string> = {
  'GHSA-5j98-mcp5-4vw2': 'glob CLI -c/--cmd: nothing here runs the glob CLI.',
  'GHSA-3g3m-2fjr-6pw4': `glob AbortSignal timeout bypass: no caller passes a signal. ${BUILD_TOOL_PATTERNS}`,
  'GHSA-3ppc-4f35-3m26': `minimatch ReDoS. ${BUILD_TOOL_PATTERNS}`,
  'GHSA-7r86-cg39-jmmj': `minimatch ReDoS. ${BUILD_TOOL_PATTERNS}`,
  'GHSA-23c5-xmqv-rm74': `minimatch ReDoS. ${BUILD_TOOL_PATTERNS}`,
  'GHSA-g3hv-75wg-m249': `minimatch globparts amplification. ${BUILD_TOOL_PATTERNS}`,
};

const Report = v.record(
  v.string(),
  v.array(v.object({ url: v.string(), title: v.string(), severity: v.string() })),
);

const proc = Bun.spawnSync(['bun', 'audit', '--json'], {
  cwd: join(import.meta.dirname, '..'),
  stderr: 'pipe',
});
const parsed = parseJson(proc.stdout.toString(), Report);
if (!parsed.ok) {
  throw new Error(`bun audit gave no report: ${parsed.error}\n${proc.stderr.toString()}`);
}

const reported: Advisory[] = Object.entries(parsed.value).flatMap(([pkg, advisories]) =>
  advisories.map(({ url, title, severity }) => ({
    ghsa: url.slice(url.lastIndexOf('/') + 1),
    pkg,
    severity,
    title,
  })),
);

const violations = auditViolations(reported, ACCEPTED);
if (violations.length > 0) {
  console.error(`Dependency advisories:\n${violations.join('\n')}`);
  process.exit(1);
}
console.log(`No unaccepted advisories (${String(Object.keys(ACCEPTED).length)} accepted).`);
