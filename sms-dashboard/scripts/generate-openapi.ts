// --check writes nothing and fails when openapi.json differs, hand edits included.
import { openapiDocument } from './openapi.js';

const file = Bun.file(new URL('../openapi.json', import.meta.url));
const generated = `${JSON.stringify(await openapiDocument(), null, 2)}\n`;

if (!process.argv.includes('--check')) {
  await Bun.write(file, generated);
} else if (((await file.exists()) ? await file.text() : '') !== generated) {
  console.error('openapi.json is not what the contract generates: run `bun run openapi`.');
  process.exit(1);
}
