const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const root=path.join(__dirname,'..');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const readme=fs.readFileSync(path.join(root,'README.md'),'utf8');
const viteConfig=fs.readFileSync(path.join(root,'dashboard','vite.config.js'),'utf8');

test('the local dashboard launcher trusts the Windows CA store used by the Railway proxy',()=>{
  assert.match(pkg.scripts['dashboard:dev'],/^node --use-system-ca /);
  assert.match(pkg.scripts['dashboard:dev'],/vite\.js --config dashboard\/vite\.config\.js$/);
  assert.match(viteConfig,/DEV_API_TARGET='https:\/\//);
});

test('the README documents both safe launch forms and warns against duplicate live workers',()=>{
  assert.match(readme,/project-npm\.ps1 run dashboard:dev/);
  assert.match(readme,/node\.exe' --use-system-ca \.\\node_modules\\vite\\bin\\vite\.js/);
  assert.match(readme,/Do not also run `start`/);
  assert.match(readme,/Vite `502`/);
});
