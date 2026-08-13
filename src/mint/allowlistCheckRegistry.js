const { Interface, isAddress } = require('ethers');
const { ValidationError } = require('../validation/domain');

const DEFINITIONS=[
  'isWhitelisted(address)', 'isAllowlisted(address)', 'whitelist(address)', 'allowlist(address)',
].map(signature=>({signature,fragment:{type:'function',name:signature.slice(0,signature.indexOf('(')),stateMutability:'view',inputs:[{name:'account',type:'address'}],outputs:[{name:'eligible',type:'bool'}]}}));
const CHECKS=Object.freeze(Object.fromEntries(DEFINITIONS.map(value=>[value.signature,{...value,iface:new Interface([value.fragment])}])));

function customDefinition(signature,fragment) {
  if (!fragment||Array.isArray(fragment)||typeof fragment!=='object') throw new ValidationError({field:'allowlistCheck.abiFragment',message:'must be a function ABI fragment'});
  if (fragment.type!=='function'||fragment.stateMutability!=='view'||fragment.inputs?.length!==1||fragment.inputs[0]?.type!=='address'||fragment.outputs?.length!==1||fragment.outputs[0]?.type!=='bool') {
    throw new ValidationError({field:'allowlistCheck.abiFragment',message:'must be a view function accepting one address and returning one bool'});
  }
  let iface;
  try {iface=new Interface([fragment]);} catch {throw new ValidationError({field:'allowlistCheck.abiFragment',message:'must be a valid ABI fragment'});}
  const fn=iface.getFunction(fragment.name);
  if(fn.format('sighash')!==signature)throw new ValidationError({field:'allowlistCheck.signature',message:'must match the ABI fragment'});
  return {signature,fragment,iface};
}

function validateAllowlistCheck(input) {
  if (input===undefined||input===null) return null;
  if (!input||Array.isArray(input)||typeof input!=='object') throw new ValidationError({field:'allowlistCheck',message:'must be an object'});
  const signature=String(input.signature||'').replace(/\s+/g,'');
  const definition=CHECKS[signature]||customDefinition(signature,input.abiFragment);
  if (input.account!==undefined&&!isAddress(input.account)) throw new ValidationError({field:'allowlistCheck.account',message:'must be a valid Ethereum address'});
  return {signature,account:input.account||null,abiFragment:CHECKS[signature]?null:definition.fragment};
}

async function runAllowlistCheck({check,chain,contractAddress,walletAddress,providerService}) {
  if (!check) return null;
  const definition=CHECKS[check.signature]||customDefinition(check.signature,check.abiFragment);
  const account=check.account||walletAddress;
  const data=definition.iface.encodeFunctionData(definition.fragment.name,[account]);
  const encoded=await providerService.perform(chain,'allowlistCheck',provider=>provider.call({to:contractAddress,data}));
  const eligible=Boolean(definition.iface.decodeFunctionResult(definition.fragment.name,encoded)[0]);
  if (!eligible) throw new ValidationError({field:'allowlistCheck',message:'wallet is not eligible for this mint'});
  return {signature:check.signature,account,eligible};
}

module.exports={ALLOWLIST_CHECKS:CHECKS,runAllowlistCheck,validateAllowlistCheck};
