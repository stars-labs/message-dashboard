import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isMigration } from './migration-rules.ts';
import { splitStatements } from './d1-sql.ts';

describe('splitStatements', () => {
  test('splits at each semicolon that ends a statement', () => {
    expect(splitStatements('CREATE TABLE a (id INTEGER);\nINSERT INTO a VALUES (1);\n')).toEqual([
      'CREATE TABLE a (id INTEGER);',
      'INSERT INTO a VALUES (1);',
    ]);
  });

  test('keeps a trigger body, CASE … END and all, as one statement', () => {
    const trigger = `CREATE TRIGGER t BEFORE UPDATE ON a
WHEN NEW.id IS NULL
BEGIN
  UPDATE a SET id = CASE WHEN id > 0 THEN 1 END;
  SELECT RAISE(ABORT, 'no; id');
END;`;

    expect(splitStatements(`${trigger}\nDROP TABLE b;`)).toEqual([trigger, 'DROP TABLE b;']);
  });

  test('ignores semicolons in strings and comments', () => {
    expect(splitStatements("-- one; two\nINSERT INTO a VALUES ('x;y'); /* ; */ SELECT 1;")).toEqual(
      ["-- one; two\nINSERT INTO a VALUES ('x;y');", '/* ; */ SELECT 1;'],
    );
  });

  test('drops a trailing comment or blank text', () => {
    expect(splitStatements('SELECT 1;\n-- done\n\n')).toEqual(['SELECT 1;']);
  });

  test('refuses a final statement without its semicolon', () => {
    expect(() =>
      splitStatements('SELECT 1;\nCREATE TRIGGER t BEFORE INSERT ON a BEGIN SELECT 1;'),
    ).toThrow('does not end');
  });

  test('splits every migration in the repository into whole statements', async () => {
    const dir = join(import.meta.dirname, '..', 'migrations');
    // 0002, applied in 2025 and unchangeable since, ends in shell heredoc residue.
    const names = (await readdir(dir))
      .filter(isMigration)
      .filter((name) => name !== '0002_use_iccid_as_primary_key.sql');

    for (const name of names) {
      const sql = await Bun.file(join(dir, name)).text();
      const statements = splitStatements(sql);
      expect(statements.length, name).toBeGreaterThan(0);
      const squeezed = (text: string) => text.replaceAll(/\s+/g, '');
      const joined = squeezed(statements.join(''));
      expect(squeezed(sql).startsWith(joined), name).toBe(true);
      expect(
        squeezed(sql)
          .slice(joined.length)
          .replaceAll(/--[^\n]*/g, ''),
        name,
      ).toBe('');
    }
  });
});
