import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'svelte/compiler';
import ts from 'typescript';
import { routeTable } from '../test/worker-harness.js';

// The URLs the dashboard builds by hand, checked against the routes the Worker
// registers. Every string or template in client/ that names an /api/ path must
// be the URL argument of a call whose method this test can read.

const CLIENT = new URL('../client/', import.meta.url);
const PARAM = '\0';

interface ClientCall {
  site: string;
  method: string;
  path: string;
}

function clientSources(): { file: string; script: string }[] {
  return readdirSync(CLIENT, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(ts|svelte)$/.test(file) && !file.endsWith('.test.ts'))
    .sort()
    .flatMap((file) => {
      const source = readFileSync(new URL(file, CLIENT), 'utf8');
      if (!file.endsWith('.svelte')) return [{ file, script: source }];
      const { instance, module } = parse(source, { modern: true });
      return [instance, module].flatMap((block) => {
        if (!block) return [];
        const tag = source.slice(block.start, block.end);
        return [{ file, script: tag.slice(tag.indexOf('>') + 1, tag.lastIndexOf('</script')) }];
      });
    });
}

/** The literal's text with every substitution replaced by PARAM. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => PARAM + span.literal.text).join('');
  }
  return null;
}

/** The method an options argument asks for: `{ method }`, `jsonBody(method, …)`, or none. */
function optionsMethod(options: ts.Expression | undefined): string | null {
  if (options === undefined) return 'GET';
  if (ts.isObjectLiteralExpression(options)) {
    const method = options.properties.find(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) && property.name.getText() === 'method',
    );
    if (method === undefined) return 'GET';
    return ts.isStringLiteral(method.initializer) ? method.initializer.text : null;
  }
  if (ts.isCallExpression(options) && options.expression.getText() === 'jsonBody') {
    const [method] = options.arguments;
    return method !== undefined && ts.isStringLiteral(method) ? method.text : null;
  }
  return null;
}

/** The method of the call that sends `url`, or null when the use is not one this test knows. */
function sentWith(url: ts.Expression): string | null {
  const call = url.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== url) return null;
  switch (call.expression.getText()) {
    case 'withQuery':
      return sentWith(call);
    case 'request':
      return optionsMethod(call.arguments[2]);
    case 'fetch':
      return optionsMethod(call.arguments[1]);
    case 'post':
      return 'POST';
    default:
      return null;
  }
}

function clientCalls(): ClientCall[] {
  return clientSources().flatMap(({ file, script }) => {
    const source = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true);
    const calls: ClientCall[] = [];
    const visit = (node: ts.Node) => {
      // A leading substitution is the origin, as in `${auth.baseUrl}/api/auth/me`.
      const url = literalText(node)?.replace(new RegExp(`^${PARAM}`), '');
      if (url?.startsWith('/api/') && ts.isExpression(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        const site = `${file}:${String(line + 1)}`;
        const path = url.split('?', 1)[0] ?? '';
        calls.push({ site, method: sentWith(node) ?? 'unknown', path });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return calls;
  });
}

function segments(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** A client segment built with a substitution may be any value, so it fits any route segment. */
function fits(call: ClientCall, route: { method: string; path: string }): boolean {
  const client = segments(call.path);
  const server = segments(route.path);
  return (
    route.method === call.method &&
    client.length === server.length &&
    client.every((segment, index) => {
      const expected = server[index] ?? '';
      return segment.includes(PARAM) || expected.startsWith(':') || segment === expected;
    })
  );
}

const apiRoutes = routeTable().filter(({ path }) => path.startsWith('/api/'));

describe('client routes', () => {
  const calls = clientCalls();

  test('reads the URLs in both TypeScript modules and Svelte components', () => {
    const files = new Set(
      calls.map(({ site }) => site.slice(site.lastIndexOf('.'), site.indexOf(':'))),
    );
    expect([...files].sort()).toEqual(['.svelte', '.ts']);
  });

  test('every hand-built URL is sent by a call whose method is known', () => {
    expect(calls.filter(({ method }) => method === 'unknown').map(({ site }) => site)).toEqual([]);
  });

  test('every hand-built URL names a route the Worker registers', () => {
    const unmatched = calls
      .filter((call) => !apiRoutes.some((route) => fits(call, route)))
      .map(({ site, method, path }) => `${site} ${method} ${path.replaceAll(PARAM, ':param')}`);
    expect(unmatched).toEqual([]);
  });
});
