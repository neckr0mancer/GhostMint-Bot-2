const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'dashboard','src','App.jsx'),'utf8');
const styles=fs.readFileSync(path.join(root,'dashboard','src','styles.css'),'utf8');
const detailsStart=app.indexOf('function WalletDetails(');
const detailsEnd=app.indexOf('// ── New wallet:',detailsStart);
const details=app.slice(detailsStart,detailsEnd);
const qrStart=app.indexOf('function AddressQr(');
const qrEnd=app.indexOf('const CHAIN_FAMILIES',qrStart);
const addressQr=app.slice(qrStart,qrEnd);

test('wallet actions keep their fixed order immediately before the persistent detail tabs',()=>{
  const row=details.indexOf('<div className="wallet-action-row"');
  const tabs=details.indexOf('<SubTabs tabs={WALLET_DETAIL_TABS}');
  const firstTabPanel=details.indexOf("{tab==='summary'");
  assert.ok(row>=0,'WalletDetails must render the wallet action row');
  assert.ok(row<tabs&&tabs<firstTabPanel,
    'the action row must precede the tabs and stay outside every tab-conditional panel');

  const buy=details.indexOf('wallet-action-label">Buy');
  const receive=details.indexOf('wallet-action-label">Receive');
  const send=details.indexOf('wallet-action-label">Send');
  const swap=details.indexOf('wallet-action-label">Swap');
  assert.ok(buy<receive&&receive<send&&send<swap,'the final action positions are Buy, Receive, Send, Swap');
});

test('Receive is the only live action and the future actions are visibly, accessibly disabled',()=>{
  for(const label of ['Buy','Send','Swap']){
    assert.match(details,new RegExp(`disabled aria-label="${label} — Coming soon"`));
  }
  const receiveButton=details.slice(details.indexOf('<button type="button" className="wallet-action is-ready"'),
    details.indexOf('</button>',details.indexOf('<button type="button" className="wallet-action is-ready"')));
  assert.match(receiveButton,/aria-label=\{`Receive to \$\{wallet\.label\}`\}/);
  assert.match(receiveButton,/aria-haspopup="dialog"/);
  assert.match(receiveButton,/onClick=\{openReceive\}/);
  assert.doesNotMatch(receiveButton,/\bdisabled\b/);
});

test('Receive switches the single details dialog to the current wallet public address only',()=>{
  assert.equal((details.match(/<Overlay\b/g)||[]).length,1,
    'WalletDetails must keep one aria-modal Overlay instead of stacking a Receive dialog');
  assert.match(details,/return <Overlay open onClose=\{closeWalletOverlay\}/);
  assert.match(details,/showingReceive\?<div className="g wallet-receive-view">/);
  assert.match(details,/Verify the network before funding\./);
  assert.match(details,/\{networkLabel\} is this wallet&apos;s saved home/);
  assert.match(details,/<AddressQr address=\{wallet\.address\} label=\{`\$\{wallet\.label\} public address`\}\/\>/);
  assert.equal((details.match(/<AddressQr\b/g)||[]).length,1,
    'the QR belongs only to the dedicated Receive view, not the Summary tab');

  assert.match(addressQr,/QRCode\.toDataURL\(address,/);
  assert.match(addressQr,/<CopyButton value=\{address\}/);
  assert.match(addressQr,/only the public EVM address/);
  assert.match(addressQr,/never contains a private key or recovery phrase/);
});

test('Receive close returns to details, restores focus, and wallet changes reset Receive',()=>{
  assert.match(details,/if\(showingReceive\)\{restoreReceiveFocus\.current=true;setDetailView\('tabs'\);return;\}/,
    'the Overlay close and Escape path must return Receive to details before closing the parent');
  assert.match(details,/ref=\{receiveTriggerRef\}/);
  assert.match(details,/setTimeout\(\(\)=>receiveTriggerRef\.current\?\.focus\(\),0\)/);
  assert.match(details,/const walletChanged=detailWalletAddress\.current!==wallet\.address/);
  assert.match(details,/const showingReceive=detailView==='receive'&&!walletChanged/);
  assert.match(details,/detailWalletAddress\.current=wallet\.address;[\s\S]*setDetailView\('tabs'\);[\s\S]*\},\[wallet\.address\]\);/,
    'a newly selected address must synchronously suppress stale Receive content and reset the view');
});

test('wallet actions use a four-column responsive grid without horizontal overflow',()=>{
  assert.match(styles,/\.wallet-action-row\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(styles,/\.wallet-action\{appearance:none;min-width:0;min-height:72px/);
  assert.match(styles,/@media\(max-width:420px\)\{[\s\S]*\.wallet-action-row\{gap:5px\}/);
});
