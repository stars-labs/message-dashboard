import { execSync } from 'child_process';

// This script works around Cloudflare Pages passing incorrect arguments
console.log('Starting build process...');
console.log('Arguments received:', process.argv.slice(2));

try {
  // Always run vite build, ignoring any arguments passed
  execSync('npx vite build', { stdio: 'inherit' });
  console.log('Build completed successfully!');
} catch (error) {
  console.error('Build failed:', error.message);
  process.exit(1);
}