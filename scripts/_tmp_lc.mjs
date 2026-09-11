import fs from 'fs';
import path from 'path';
const nm = 'node_modules';
function findParent(pkg) {
  const p = path.join(nm, pkg, 'package.json');
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { deps: j.dependencies || {}, opt: j.optionalDependencies || {}, peer: j.peerDependencies || {} };
  } catch { return null; }
}
const roots = ['@tailwindcss/vite', 'vite', 'astro', '@astrojs/vite', '@vitejs/plugin-react', 'vite-plugin-solid', '@tailwindcss/node', 'tailwindcss'];
for (const r of roots) {
  const info = findParent(r);
  if (info) {
    for (const k of ['deps', 'opt', 'peer']) {
      if (info[k]['lightningcss']) {
        console.log(r + ' => ' + k + '["lightningcss":"' + info[k]['lightningcss'] + '"]');
      }
    }
  }
}
// also check if lightningcss is optional (platform binary)
const lc = findParent('lightningcss');
if (lc) console.log('lightningcss version:', lc.deps ? '(root)' : '', JSON.parse(fs.readFileSync(path.join(nm,'lightningcss','package.json'),'utf8')).version);
const lcBin = findParent('lightningcss-win32-x64-msvc');
if (lcBin) console.log('lightningcss-win32-x64-msvc is OPTIONAL dep of:', '');
console.log('--- scan complete ---');
