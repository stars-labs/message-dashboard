// Splits a migration into the statements D1's batch() takes one at a time. A semicolon
// ends a statement, except inside CREATE TRIGGER, which ends at the END that closes its
// body; CASE … END pairs inside the body are counted so their END does not.
const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;
const CLOSING: Record<string, string> = { "'": "'", '"': '"', '`': '`', '[': ']' };

function onlyComments(text: string): boolean {
  return (
    text
      .replaceAll(/--[^\n]*/g, '')
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .trim() === ''
  );
}

export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let head: string[] = [];
  let caseDepth = 0;
  let closedTrigger = false;

  const inTrigger = () =>
    head[0] === 'CREATE' &&
    (head[1] === 'TRIGGER' || (/^TEMP(ORARY)?$/.test(head[1] ?? '') && head[2] === 'TRIGGER'));

  for (let i = 0; i < sql.length; i++) {
    const char = sql.charAt(i);
    const closing = CLOSING[char];
    if (closing !== undefined) {
      const end = sql.indexOf(closing, i + 1);
      i = end === -1 ? sql.length : end;
      closedTrigger = false;
    } else if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
    } else if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 1;
    } else if (char === ';') {
      if (!inTrigger() || closedTrigger) {
        statements.push(sql.slice(start, i + 1).trim());
        start = i + 1;
        head = [];
        caseDepth = 0;
      }
      closedTrigger = false;
    } else {
      WORD.lastIndex = i;
      const match = WORD.exec(sql);
      if (match === null) continue;
      const word = match[0].toUpperCase();
      if (head.length < 3) head.push(word);
      if (word === 'CASE') caseDepth++;
      if (word === 'END' && caseDepth > 0) {
        caseDepth--;
        closedTrigger = false;
      } else {
        closedTrigger = word === 'END';
      }
      i += match[0].length - 1;
    }
  }

  const rest = sql.slice(start);
  if (!onlyComments(rest)) {
    throw new Error(`SQL does not end with a whole statement: ${rest.trim().slice(0, 80)}`);
  }
  return statements;
}
