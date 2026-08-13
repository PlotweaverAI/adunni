const fs = require('fs');
const html = fs.readFileSync('C:\\Users\\opdli\\Downloads\\Adunni AI Human Demo (standalone).html', 'utf-8');
const start = html.indexOf('<script type="__bundler/template">');
const afterTag = html.indexOf('\n', start) + 1;
const endTag = html.indexOf('\n  </script>', afterTag);
const raw = html.slice(afterTag, endTag).trim();
const tpl = JSON.parse(raw);
fs.writeFileSync('C:\\adunni\\demo-template.html', tpl);
console.log('Extracted', tpl.length, 'chars');
