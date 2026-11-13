const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

function source(file){
  return fs.readFileSync(path.join(__dirname,'..',file),'utf8');
}

test('wallet history leaves its loading state after the current request settles',()=>{
  const shared=source('dashboard/src/shared.jsx');
  const wallet=source('dashboard/src/WalletHistory.jsx');
  const account=source('dashboard/src/AccountWalletHistory.jsx');

  assert.match(shared,/const \[resolvedPath,setResolvedPath\]=useState\(null\)/);
  assert.match(shared,/const \[dataPath,setDataPath\]=useState\(null\)/);
  assert.match(shared,/setData\(value\);setDataPath\(path\);setResolvedPath\(path\)/);
  assert.match(shared,/setError\(value\.message\);setStatus\(value\.status\?\?null\);setResolvedPath\(path\)/);
  assert.match(shared,/return \{data,error,status,load,resolvedPath,dataPath\}/);

  for(const component of [wallet,account]){
    assert.match(component,/const historyData=listing\.dataPath===path\?listing\.data:null/);
    assert.match(component,/const currentError=listing\.resolvedPath===path\?listing\.error:''/);
    assert.doesNotMatch(component,/const historyData=listing\.resolvedPath===path/);
  }
});
