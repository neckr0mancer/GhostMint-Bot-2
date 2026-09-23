const {defineConfig}=require('vite');
const react=require('@vitejs/plugin-react');
const path=require('node:path');
// Dev-only. `server` is ignored by `vite build`, so the production bundle is byte-identical with
// or without this block -- it exists so the dashboard can be developed against the real deployed
// API instead of booting a second local instance of src/server.js. A local API must only be used
// with an isolated database and GHOSTMINT_DASHBOARD_ONLY=true; otherwise a second process could
// claim and broadcast due work. The default remains the deployed API so ordinary UI work leaves
// exactly one process owning the workers.
const DEV_API_TARGET=(process.env.GHOSTMINT_DEV_API_TARGET
  || 'https://ghostmint-bot-2-production-d3ca.up.railway.app').replace(/\/+$/,'');
const devProxyEntry={target:DEV_API_TARGET,changeOrigin:true,secure:true,
  // The session and CSRF cookies are Secure + SameSite=Strict. Stripping the domain attribute
  // re-scopes them to localhost, which counts as a secure context, so both survive the hop.
  cookieDomainRewrite:''};
module.exports=defineConfig({root:__dirname,plugins:[react()],base:'/dashboard/',
  server:{proxy:{'/api':devProxyEntry,'/ws':{...devProxyEntry,ws:true}}},
  build:{outDir:path.resolve(__dirname,'../public/dashboard'),emptyOutDir:true,
  // Keep classic `(max-width: 700px)` media queries in the minified CSS instead of the
  // modern range-context `(width<=700px)` form: a real parsing bug was found where the
  // latter fails to evaluate correctly (matchMedia() says false, style engine applies it
  // anyway), causing mobile-only rules to leak into desktop layouts.
  cssTarget:'chrome90'}});
