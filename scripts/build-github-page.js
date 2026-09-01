#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCspOrigins, buildBackgroundStyle, injectTitle, injectApiBase } from './csp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

const envPath = path.join(rootDir, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const apiBase = parseCspOrigins(process.env.API_BASE || '');
const title = process.env.TITLE || '';
const backgroundImage = process.env.BACKGROUND_IMAGE || '';

console.log('Config from env:', { apiBase, title, backgroundImage });

if (!fs.existsSync(distDir)) {
  throw new Error('dist directory does not exist. Run the frontend build before this script.');
}

const htmlFiles = fs.readdirSync(distDir).filter((file) => file.endsWith('.html'));
for (const file of htmlFiles) {
  const filePath = path.join(distDir, file);
  let html = fs.readFileSync(filePath, 'utf8');

  html = injectTitle(html, title);
  html = injectApiBase(html, apiBase);

  if (backgroundImage) {
    const bgStyle = buildBackgroundStyle(backgroundImage);
    html = html.replace('</head>', `${bgStyle}\n</head>`);
  }

  fs.writeFileSync(filePath, html, 'utf8');
  console.log(`Injected config into ${file}`);
}

console.log('Build complete!');
