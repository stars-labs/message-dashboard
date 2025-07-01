import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';

// This script works around Cloudflare Pages passing incorrect arguments
console.log('Starting build process...');
console.log('Arguments received:', process.argv.slice(2));

try {
  // Always run vite build, ignoring any arguments passed
  execSync('npx vite build', { stdio: 'inherit' });
  
  // Ensure dist directory exists
  if (!existsSync('dist')) {
    mkdirSync('dist', { recursive: true });
  }
  
  console.log('Build completed successfully!');
  console.log('Output directory: dist');
} catch (error) {
  console.error('Build failed:', error.message);
  process.exit(1);
}