export type Viewport = 'desktop' | 'mobile';

export interface PageIssue {
  kind: 'console' | 'pageerror' | 'http' | 'requestfailed' | 'settle' | 'route';
  text: string;
}

export interface PageCapture {
  view: string;
  viewport: Viewport;
  file: string;
  finalHash: string;
  issues: PageIssue[];
}

interface ReportMeta {
  baseUrl: string;
  capturedAt: string;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function allIssues(capture: PageCapture): PageIssue[] {
  const expected = `#${capture.view}`;
  if (capture.finalHash === expected) return capture.issues;
  return [
    { kind: 'route', text: `redirected to ${capture.finalHash || '(no hash)'}` },
    ...capture.issues,
  ];
}

function renderCapture(capture: PageCapture): string {
  const issues = allIssues(capture);
  const list =
    issues.length === 0
      ? '<p class="ok">No console errors, failed requests or HTTP errors.</p>'
      : `<ul>${issues
          .map((issue) => `<li><b>${issue.kind}</b> ${escapeHtml(issue.text)}</li>`)
          .join('')}</ul>`;
  const file = escapeHtml(capture.file);
  return `<section class="${issues.length === 0 ? '' : 'bad'}">
<h2>#${escapeHtml(capture.view)} · ${capture.viewport}</h2>
${list}
<a href="${file}"><img src="${file}" alt="#${escapeHtml(capture.view)} ${capture.viewport}" loading="lazy"></a>
</section>`;
}

/** A self-contained page that shows every screenshot beside what the browser reported. */
export function renderReport(captures: PageCapture[], meta: ReportMeta): string {
  const withIssues = captures.filter((capture) => allIssues(capture).length > 0).length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page screenshots</title>
<style>
:root { --bg: #fff; --fg: #111; --muted: #666; --line: #ddd; --bad: #b91c1c; --ok: #15803d; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #111; --fg: #eee; --muted: #999; --line: #333; --bad: #f87171; --ok: #4ade80; }
}
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
header p { color: var(--muted); margin: 4px 0; }
section { border-top: 1px solid var(--line); padding: 16px 0; }
section.bad h2 { color: var(--bad); }
.ok { color: var(--ok); }
li { overflow-wrap: anywhere; }
img { display: block; max-width: 100%; border: 1px solid var(--line); }
</style>
</head>
<body>
<header>
<h1>Page screenshots</h1>
<p>${escapeHtml(meta.baseUrl)} · captured ${escapeHtml(meta.capturedAt)}</p>
<p>${String(withIssues)} of ${String(captures.length)} captures have issues</p>
</header>
${captures.map(renderCapture).join('\n')}
</body>
</html>
`;
}
