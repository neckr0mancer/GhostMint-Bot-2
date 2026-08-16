import React,{useEffect,useRef,useState} from 'react';
import {api,confirmDialog,Field,Form,notify,promptDialog,Select,setPendingMintPrefill,useLoad} from '../shared.jsx';

export function formatWhen(value){if(!value)return 'No timestamp';const date=new Date(value);return Number.isNaN(date.getTime())?'No timestamp':date.toLocaleString();}
export function formatAmount(value,suffix=''){const parsed=Number(value);return `${Number.isFinite(parsed)?parsed.toFixed(4):'0.0000'}${suffix}`;}

const ADDRESS_SHAPE=/^0x[0-9a-fA-F]{40}$/;
// A real USD figure of $0 is possible and must render as $0.00, not be dropped -- only a missing
// price feed (null) omits the parenthetical entirely.
function usdSuffix(usd){return usd===null||usd===undefined?'':` (~$${usd.toFixed(2)})`;}

// A condensed version of the full Minting page's auto-detect-and-mint path, for the common single-
// wallet case, tucked inside each theme's Mint Now hero (see QuickMintToggle below) rather than its
// own standing card -- same /api/mints/detect|preview|confirm calls, just without batch wallets,
// saved presets, or the advanced manual-calldata override, which stay exclusive to the full page
// ("Advanced options" links there for those). No manual "Detect" button: detection runs itself the
// moment a full, valid-shaped address is present -- on every keystroke while typing, and critically
// also on paste, which never fires a blur event the way tabbing/clicking away does.
export function QuickMint({go}){
  const wallets=useLoad('/api/wallets',[],'wallets.changed');
  const [walletLabel,setWalletLabel]=useState('');
  const [contractAddress,setContractAddress]=useState('');
  const [quantity,setQuantity]=useState('1');
  const [detecting,setDetecting]=useState(false);
  const [detected,setDetected]=useState(null);
  const [preview,setPreview]=useState(null);
  const [confirmResult,setConfirmResult]=useState(null);
  const [busy,setBusy]=useState(false);
  const lastDetected=useRef('');
  const previewRef=useRef(null);
  useEffect(()=>{if(!walletLabel&&wallets.data?.length)setWalletLabel(wallets.data[0].label);},[wallets.data]);
  function reset(){setContractAddress('');setQuantity('1');setDetected(null);setPreview(null);setConfirmResult(null);lastDetected.current='';}
  // Whatever's already typed here follows to the full page instead of being lost -- landing on an
  // empty contract field after already having pasted one in is exactly the dead-end this avoids.
  function goToFullMint(){setPendingMintPrefill({contractAddress,quantity,walletLabel});go('Minting');}
  async function detect(addressOverride,quantityOverride){
    const trimmed=(addressOverride??contractAddress).trim();
    const effectiveQuantity=quantityOverride??quantity;
    if(!trimmed){notify('Enter a contract address first.',{type:'error'});return;}
    setDetecting(true);
    try{
      const result=await api(`/api/mints/detect?contractAddress=${encodeURIComponent(trimmed)}&quantity=${encodeURIComponent(effectiveQuantity)}`);
      lastDetected.current=`${trimmed}:${effectiveQuantity}`;
      setDetected(result);
      // A quantity already typed in before detection finished can be higher than the contract's
      // real per-wallet cap -- pull it back down rather than leaving an already-invalid value sitting
      // in the field.
      if(result.maxPerWallet&&Number(effectiveQuantity)>result.maxPerWallet)setQuantity(String(result.maxPerWallet));
      const label=result.isSeaDrop?'SeaDrop drop':'contract';
      notify(result.priceKnown?`Detected ${label} on ${result.chain} — price read from the contract.`:`Detected ${label} on ${result.chain}, but the price couldn't be read.`,{type:result.priceKnown?'success':'info'});
    }catch(value){notify(value.message,{type:'error'});setDetected(null);}
    finally{setDetecting(false);}
  }
  // Takes the just-changed value directly rather than reading state, since setState hasn't applied
  // yet at the point this runs inside the same onChange handler.
  function autoDetectIfReady(value=contractAddress,quantityValue=quantity){const trimmed=value.trim();if(ADDRESS_SHAPE.test(trimmed)&&`${trimmed}:${quantityValue}`!==lastDetected.current)detect(trimmed,quantityValue);}
  function handleAutoDetectBlur(){autoDetectIfReady();}
  async function submit(event){
    event.preventDefault();
    if(!detected){notify('Detect the contract first.',{type:'error'});return;}
    // Unlike the full Minting page, this widget has no manual-value override -- proceeding with an
    // unknown price would silently submit valueWei:'0', which could treat a paid mint as free.
    // Send unknown-price contracts to the full page instead of guessing.
    if(!detected.priceKnown){goToFullMint();return;}
    setBusy(true);
    try{
      const input={walletLabel,contractAddress:contractAddress.trim(),methodSignature:detected.methodSignature,
        seaDropAddress:detected.seaDropAddress||undefined,arguments:detected.arguments,valueWei:detected.valueWei||'0'};
      setPreview(await api('/api/mints/preview',{method:'POST',body:JSON.stringify(input)}));
      setConfirmResult(null);
      notify('Simulation passed -- review the details below and confirm to broadcast.',{type:'success'});
      previewRef.current?.scrollIntoView({behavior:'smooth',block:'nearest'});
    }catch(value){notify(value.message,{type:'error'});}
    finally{setBusy(false);}
  }
  // Single wallet here, but /api/mints/confirm now always reports a per-entry outcome rather than
  // throwing on failure (so a batch elsewhere can't have one bad wallet cancel the rest) -- must
  // check result.status explicitly instead of treating "the request didn't throw" as success.
  async function confirmMint(){
    if(!await confirmDialog('Broadcast this simulation-backed mint?'))return;
    setBusy(true);
    try{
      const response=await api('/api/mints/confirm',{method:'POST',body:JSON.stringify({previewToken:preview.previewToken,confirmation:'CONFIRM'})});
      const [result]=response.results;
      if(result?.status==='success'){notify('Mint submitted.',{type:'success'});reset();}
      else{setConfirmResult(result);notify(`Mint failed: ${result?.error||'unknown reason'}`,{type:'error'});}
    }catch(value){notify(value.message,{type:'error'});}
    finally{setBusy(false);}
  }
  return <Form className="quick-mint" title="Quick mint" onSubmit={submit}>
    <fieldset disabled={busy}>
      <div className="field-row">
        <Select label="Wallet" options={wallets.data?.map(w=>w.label)} value={walletLabel} onChange={e=>setWalletLabel(e.target.value)}/>
        <Field label={detected?.maxPerWallet?`Quantity (max ${detected.maxPerWallet} per wallet)`:'Quantity'} type="number" min="1" max={detected?.maxPerWallet||100} value={quantity} onChange={e=>{setQuantity(e.target.value);autoDetectIfReady(contractAddress,e.target.value);}} onBlur={handleAutoDetectBlur}/>
      </div>
      <Field label="Contract address" required={false} placeholder="0x…" value={contractAddress}
        onChange={e=>{setContractAddress(e.target.value);setDetected(null);autoDetectIfReady(e.target.value,quantity);}} onBlur={handleAutoDetectBlur}/>
      {detecting&&<p className="mint-detecting"><span className="spinner spinner-quiet" aria-hidden="true"/>Detecting…</p>}
      {!detecting&&detected&&<p className="mint-detected-summary">Detected on {detected.chain}: <code>{detected.methodSignature}</code>
        {detected.priceKnown?` · ${detected.valueWei==='0'?'free':detected.valueWei+' wei'}`:' · price not exposed by this contract -- enter it manually on the full page'}
        {detected.soldOut
          ?(detected.displayPrice?` · Sold out — floor ${detected.displayPrice.eth} ETH${usdSuffix(detected.displayPrice.usd)}`:' · Sold out — floor price unavailable')
          :(detected.displayPrice?usdSuffix(detected.displayPrice.usd):'')}</p>}
      <button type="submit" disabled={!detected||busy}>{detected&&!detected.priceKnown?'Open full page to set price':'Preview mint'}</button>
    </fieldset>
    {preview&&<div className="preview" ref={previewRef}>
      <h2>Simulation passed</h2>
      <p>Estimated total: {preview.items[0].simulation.estimatedCostWei} wei | Gas: {preview.items[0].simulation.gasLimit}</p>
      {confirmResult?<p className="warning">❌ Failed: {confirmResult.error}</p>:<button className="quiet" disabled={busy} onClick={confirmMint}>Confirm and broadcast</button>}
    </div>}
    <button type="button" className="quiet panel-cta" onClick={goToFullMint}>Advanced options →</button>
  </Form>;
}

// Sits beside each theme's own "go to the full Minting page" button inside HeroAction -- toggles
// Quick Mint open right there instead of it being its own standing card competing for space above
// the fold. A plain boolean toggle (not <details>) so it can sit inline next to that button rather
// than taking on <summary>'s own default disclosure-row styling.
export function QuickMintToggle({go}){
  const [open,setOpen]=useState(false);
  return <>
    <button type="button" className="quiet dash-hero-quickmint-toggle" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{open?'Hide quick mint':'Quick mint'}</button>
    {open&&<QuickMint go={go}/>}
  </>;
}
