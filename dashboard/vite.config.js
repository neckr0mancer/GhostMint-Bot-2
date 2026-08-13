const {defineConfig}=require('vite');
const react=require('@vitejs/plugin-react');
const path=require('node:path');
module.exports=defineConfig({root:__dirname,plugins:[react()],base:'/dashboard/',build:{outDir:path.resolve(__dirname,'../public/dashboard'),emptyOutDir:true}});
