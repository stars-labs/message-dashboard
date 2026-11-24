import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readDistFiles() {
  const distPath = path.join(__dirname, '../dist');
  const files = new Map<string, Buffer>();

  function readDir(dir: string, basePath = '') {
    const items = fs.readdirSync(dir);

    for (const item of items) {
      const fullPath = path.join(dir, item);
      const relativePath = path.join(basePath, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        readDir(fullPath, relativePath);
      } else {
        const content = fs.readFileSync(fullPath);
        const key = relativePath.replace(/\\/g, '/');
        files.set(key, content);
      }
    }
  }

  if (fs.existsSync(distPath)) {
    readDir(distPath);
  }

  return files;
}

function generateAssetsModule() {
  const files = readDistFiles();

  let code = '// Auto-generated frontend assets\n';
  code += 'export const FRONTEND_ASSETS = {\n';

  for (const [assetPath, content] of files) {
    const mimeType = getMimeType(assetPath);
    const isText =
      mimeType.startsWith('text/') || mimeType.includes('javascript') || mimeType.includes('json');

    if (isText) {
      const escaped = JSON.stringify(content.toString('utf-8'));
      code += `  '${assetPath}': { content: ${escaped}, type: '${mimeType}' },\n`;
    } else {
      const base64 = content.toString('base64');
      code += `  '${assetPath}': { content: '${base64}', type: '${mimeType}', encoding: 'base64' },\n`;
    }
  }

  code += '};\n';

  fs.writeFileSync(path.join(__dirname, '../server/frontend-assets.js'), code);
  console.log('Generated frontend-assets.js with', files.size, 'files');
}

function getMimeType(filename: string) {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = new Map([
    ['.html', 'text/html'],
    ['.js', 'application/javascript'],
    ['.css', 'text/css'],
    ['.json', 'application/json'],
    // Otherwise the manifest is stored as base64 and served as application/octet-stream,
    // which browsers reject.
    ['.webmanifest', 'application/manifest+json'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.svg', 'image/svg+xml'],
    ['.ico', 'image/x-icon'],
    ['.woff', 'font/woff'],
    ['.woff2', 'font/woff2'],
    ['.ttf', 'font/ttf'],
    ['.otf', 'font/otf'],
  ]);
  return mimeTypes.get(ext) ?? 'application/octet-stream';
}

generateAssetsModule();
