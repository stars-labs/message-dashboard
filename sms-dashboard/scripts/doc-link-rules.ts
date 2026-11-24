import { posix } from 'node:path';

export interface RepoFile {
  /** Relative to the repository root. */
  path: string;
  text: string;
}

const FENCED_CODE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;
const INLINE_CODE = /`[^`\n]*`/g;
const MARKDOWN_LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** A repo-root docs/ path in prose or a code comment; `sms-dashboard/docs/…` is not one. */
const ROOT_DOC_PATH = /(?<![\w./-])docs\/[\w./-]*?\.md\b/g;

/** Every tracked path and every directory above one. */
export function repoPaths(files: readonly string[]): Set<string> {
  const paths = new Set<string>();
  for (const file of files) {
    for (let path = file; path !== '.'; path = posix.dirname(path)) paths.add(path);
  }
  return paths;
}

function linkTarget(from: string, target: string): string | null {
  if (HAS_SCHEME.test(target) || target.startsWith('#')) return null;
  const bare = decodeURI(target.replace(/[#?].*$/, ''));
  const resolved = bare.startsWith('/')
    ? posix.normalize(bare.slice(1))
    : posix.join(posix.dirname(from), bare);
  return resolved.replace(/\/$/, '');
}

function brokenLinks(file: RepoFile, paths: ReadonlySet<string>): string[] {
  const prose = file.text.replace(FENCED_CODE, '').replace(INLINE_CODE, '');
  return [...prose.matchAll(MARKDOWN_LINK)].flatMap(([, target = '']) => {
    const resolved = linkTarget(file.path, target);
    return resolved === null || paths.has(resolved) ? [] : [target];
  });
}

function brokenRootDocPaths(file: RepoFile, paths: ReadonlySet<string>): string[] {
  return [...file.text.matchAll(ROOT_DOC_PATH)]
    .map(([path]) => path)
    .filter((path) => !paths.has(path));
}

/** `file: target` for each Markdown link, and each docs/… path named anywhere, that leads nowhere. */
export function brokenDocLinks(files: readonly RepoFile[], paths: ReadonlySet<string>): string[] {
  const broken = files.flatMap((file) => {
    const targets = [
      ...(file.path.endsWith('.md') ? brokenLinks(file, paths) : []),
      ...brokenRootDocPaths(file, paths),
    ];
    return targets.map((target) => `${file.path}: ${target}`);
  });
  return [...new Set(broken)];
}
