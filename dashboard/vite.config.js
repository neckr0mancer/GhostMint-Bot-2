const {defineConfig}=require('vite');
const react=require('@vitejs/plugin-react');
const path=require('node:path');
module.exports=defineConfig({root:__dirname,plugins:[react()],base:'/dashboard/',build:{outDir:path.resolve(__dirname,'../public/dashboard'),emptyOutDir:true,
  // Keep classic `(max-width: 700px)` media queries in the minified CSS instead of the
  // modern range-context `(width<=700px)` form: a real parsing bug was found where the
  // latter fails to evaluate correctly (matchMedia() says false, style engine applies it
  // anyway), causing mobile-only rules to leak into desktop layouts.
  cssTarget:'chrome90'}});
