#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.dirname(__dirname);

// Read all files from dist directory
function readDistFiles() {
  const distPath = path.join(rootDir, 'dist');
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
  } else {
    console.error('Dist directory not found. Run "npm run build" first.');
    process.exit(1);
  }
  
  return files;
}

// Generate the assets module
function generateAssetsModule() {
  const files = readDistFiles();
  
  let code = '// Auto-generated frontend assets for Cloudflare Workers\n';
  code += 'export const FRONTEND_ASSETS = {\n';
  
  for (const [filePath, content] of Object.entries(files)) {
    const mimeType = getMimeType(filePath);
    const isText = mimeType.startsWith('text/') || mimeType.includes('javascript') || mimeType.includes('json');
    
    if (isText) {
      // For text files, store as string
      const escaped = JSON.stringify(content.toString('utf-8'));
      code += `  '${filePath}': { content: ${escaped}, type: '${mimeType}' },\n`;
    } else {
      // For binary files, store as base64
      const base64 = content.toString('base64');
      code += `  '${filePath}': { content: '${base64}', type: '${mimeType}', encoding: 'base64' },\n`;
    }
  }
  
  code += '};\n';
  
  // Write to src directory
  const outputPath = path.join(rootDir, 'src/frontend-assets.ts');
  fs.writeFileSync(outputPath, code);
  console.log('✅ Generated frontend-assets.ts with', Object.keys(files).length, 'files');
  console.log('📁 Files included:', Object.keys(files).join(', '));
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
console.log('🚀 Building frontend assets for Cloudflare Workers...');
generateAssetsModule();