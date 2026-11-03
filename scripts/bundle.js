// Inlines the CSS and scripts into one portable file.
// Usage: node scripts/bundle.js [--fragment path]
// --fragment also writes the body-only form used when publishing the page as an Artifact.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let html = read('index.html');
html = html.replace('<link rel="stylesheet" href="css/app.css">', () => `<style>\n${read('css/app.css')}</style>`);
html = html.replace(/<script src="(js\/[\w-]+\.js)"><\/script>\n?/g, (_, file) => `<script>\n${read(file).replace(/<\/script/g, '<\\/script')}</script>\n`);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'patchlab.html'), html);
console.log(`dist/patchlab.html ${(html.length / 1024).toFixed(0)} KB`);

const i = process.argv.indexOf('--fragment');
if (i > -1) {
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)[1].replace(/<meta charset[^>]*>\s*/, '').replace(/<meta name="viewport"[^>]*>\s*/, '');
  const body = /<body>([\s\S]*)<\/body>/.exec(html)[1];
  fs.writeFileSync(process.argv[i + 1], `${head.trim()}\n${body.trim()}\n`);
  console.log(`fragment written to ${process.argv[i + 1]}`);
}
