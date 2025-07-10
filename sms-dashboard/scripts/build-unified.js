import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read all files from dist directory
function readDistFiles() {
  const distPath = path.join(__dirname, '../dist');
  const files = {};
  
  function readDir(dir, basePath = '') {
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
        files[key] = content;
      }
    }
  }
  
  if (fs.existsSync(distPath)) {
    readDir(distPath);
  }
  
  return files;
}

// Generate the assets module
function generateAssetsModule() {
  const files = readDistFiles();
  
  let code = '// Auto-generated frontend assets\n';
  code += 'export const FRONTEND_ASSETS = {\n';
  
  for (const [path, content] of Object.entries(files)) {
    const mimeType = getMimeType(path);
    const isText = mimeType.startsWith('text/') || mimeType.includes('javascript') || mimeType.includes('json');
    
    if (isText) {
      // For text files, store as string
      const escaped = JSON.stringify(content.toString('utf-8'));
      code += `  '${path}': { content: ${escaped}, type: '${mimeType}' },\n`;
    } else {
      // For binary files, store as base64
      const base64 = content.toString('base64');
      code += `  '${path}': { content: '${base64}', type: '${mimeType}', encoding: 'base64' },\n`;
    }
  }
  
  code += '};\n';
  
  // Write to file
  fs.writeFileSync(path.join(__dirname, '../server/frontend-assets.js'), code);
  console.log('Generated frontend-assets.js with', Object.keys(files).length, 'files');
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

// Run the build
generateAssetsModule();