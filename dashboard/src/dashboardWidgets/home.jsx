import React from 'react';
import {Celebrate,FirstRun,Meter,Notice,SectionCard,Skeleton,Sparkline,StatTile} from '../shared.jsx';
import {activitySucceeded} from '../activityFeed.js';
import PnlBars from '../PnlBars.jsx';
import {ChainDot,chainFromExplorer,CountdownRing,EmptyState,explorerForChain,formatEth,formatSigned,ICONS,Row,shortAddress,weiToEth} from './homeParts.jsx';

/* ==========================================================================
   Home — the redesigned page for the two primary themes (brief §9.1-D15).

   Four states per surface, never one (brief §3.8): populated, loading, empty,
   error. LOADING IS NOT EMPTY -- every empty state below is gated on
   `source.data !== null`, so an in-flight fetch shows a skeleton and never
   "No wallets yet". That is the single most common way this page gets built
   wrong, per the standing instructions.
   ========================================================================== */

// One helper drives all four states so no card can accidentally implement three of them.
function cardState(source){
  if(source.error)return 'error';
  if(source.data===null)return 'loading';
  return 'ready';
}

function CardBody({source,empty,children,skeleton='row',rows=3}){
  const state=cardState(source);
  if(state==='error')return <Notice error={{title:'Could not load this section',detail:source.error,code:source.status,onRetry:source.load}}/>;
  if(state==='loading')return <Skeleton variant={skeleton} rows={rows}/>;
  return empty??children;
}

/* --- Stat tiles (contract §3, corrected per §5.1-§5.6) --------------------
   Pinned: the row renders in every state, because zero is a value and a tile that
   vanishes when a figure is zero makes the page jump. */
function Tiles({summary,sources,pnl30}){
  const walletState=cardState(sources.wallets);
  const pnlState=cardState(sources.pnl);
  const activityState=cardState(sources.activity);
  const budgetState=cardState(sources.limits);
  const limits=sources.limits.data||{};

  // Portfolio. No 7-day delta and no sparkline: no historical balance data exists anywhere
  // (contract §5.4). A trend line here would be fabricated, so there isn't one.
  const {chainsUnavailable,other}=summary.portfolio;
  // Two different reasons for "no number", and they must not render the same way. With zero
  // wallets there is nothing that could have failed, so the total is a true 0.000 -- zero is a
  // value. With wallets present but every chain's balance null, the total is genuinely UNKNOWN
  // and prints "—"; showing 0.000 there would state that a possibly-funded wallet is empty.
  const eth=summary.portfolio.eth===null&&summary.walletCount===0?0:summary.portfolio.eth;
  const portfolioMeta=[
    `${summary.walletCount} ${summary.walletCount===1?'wallet':'wallets'}`,
    // On the live deployment two of three chains routinely fail at the RPC, so this is the
    // normal render, not an edge case (contract §5.3).
    chainsUnavailable?`${chainsUnavailable} ${chainsUnavailable===1?'chain':'chains'} unavailable`:null,
    ...other.map(entry=>`${entry.total.toFixed(3)} ${entry.symbol}`),
  ].filter(Boolean).join(' · ');

  return <div className="tiles">
    <StatTile label="Portfolio · ETH"
      value={walletState==='ready'?(eth===null?'—':formatEth(eth)):'—'}
      unit={walletState==='ready'&&eth!==null?'ETH':undefined}
      meta={walletState==='error'?'Could not load'
        :walletState==='loading'?'Loading…'
        :summary.walletCount===0?'No wallets yet':portfolioMeta}/>

    {/* Net P&L. Expect this to be NEGATIVE and ship it red: autoRecordPnl writes sale:0, so
        every auto-created record is a loss until a sale is entered by hand (contract §5.5). */}
    <StatTile label="Net P&L · 30d"
      value={pnlState==='ready'?formatSigned(pnl30.net):'—'}
      unit={pnlState==='ready'?'ETH':undefined}
      tone={pnlState==='ready'&&pnl30.net<0?'loss':pnlState==='ready'&&pnl30.net>0?'gain':undefined}
      meta={pnlState==='error'?'Could not load'
        :pnlState==='loading'?'Loading…'
        :pnl30.mints===0?'0 mints'
        :`${pnl30.mints} ${pnl30.mints===1?'mint':'mints'} · ${pnl30.sale>0
          ?`${pnl30.sale.toFixed(3)} ETH sales`:'no sales recorded'}`}>
      {pnlState==='ready'&&pnl30.points.length>1
        &&<Sparkline points={pnl30.trend} tone={pnl30.net<0?'loss':'gain'}/>}
    </StatTile>

    {/* Daily budget. The CEILING is real -- GET /api/profile/limits resolves the caller's own
        effective governance (user override -> group -> chain defaults), the same cascade the
        transaction engine enforces. Owners are ceiling-exempt and say so.
        There is deliberately NO meter and no "used" figure: rollingSpendWei under-counts by the
        full transaction value, so a meter here would be built on a wrong denominator
        (contract §5.1, PROJECT_REVIEW §1.1). The ceiling stands on its own until that is fixed. */}
    <StatTile label="Daily budget"
      value={budgetState==='ready'?(limits.ceilingExempt?'None':formatEth(weiToEth(limits.dailySpendingBudgetWei),3)):'—'}
      unit={budgetState==='ready'&&!limits.ceilingExempt?'ETH ceiling':undefined}
      meta={budgetState==='error'?'Could not load'
        :budgetState==='loading'?'Loading…'
        :limits.ceilingExempt?'Owner — exempt from ceilings'
        // Empty state copy is the prototype's, verbatim (docs/prototype-pages/home.html, the
        // "Daily budget" tile's .tm.oe). The ceiling is real and shown in BOTH states -- it is a
        // limit you already have, not a balance you accrue -- so the empty variant changes only
        // the meta line, never the value. Backlog §5.
        :summary.walletCount===0?'Applies once you mint'
        :`Per transaction ${formatEth(weiToEth(limits.maxTransactionValueWei),3)} ETH · gas ${limits.gasCeilingGwei} gwei`}/>

    {/* Scope is in the LABEL, not just the tooltip: stats() is not routed, so this is one page
        of activity, and an unqualified "Success rate" would misstate the denominator (§5.6). */}
    <StatTile label="Success · up to 20"
      value={activityState!=='ready'?'—'
        :summary.successScopeSize===0?0
        :summary.successRate===null?'—':summary.successRate}
      unit={activityState==='ready'&&(summary.successScopeSize===0||summary.successRate!==null)?'%':undefined}
      meta={activityState==='error'?'Could not load'
        :activityState==='loading'?'Loading…'
        :summary.successScopeSize===0?'No activity yet':`${summary.successCount} of ${summary.successScopeSize} successful`}>
      {activityState==='ready'&&(summary.successScopeSize===0||summary.successRate!==null)
        &&<Meter value={summary.successRate??0} max={100}/>}
    </StatTile>
  </div>;
}

/* --- Left column ---------------------------------------------------------- */
function CelebrateCard({summary,go}){
  const item=summary.latestSuccess;
  if(!item)return null;
  const explorer=explorerForChain(item.chain)||item.explorer;
  return <Celebrate title={item.title||'Mint confirmed'}
    detail={[item.walletLabel,item.time?new Date(item.time).toLocaleString():null].filter(Boolean).join(' · ')}>
    {/* Hidden entirely below 2 -- "1 in a row" is not a streak (contract §5.7). */}
    {summary.streak>=2&&<div className="streak">🔥 {summary.streak} in a row</div>}
    <div className="celebrate-actions">
      {explorer&&item.txHash&&<a className="link-button" href={`${explorer}${item.txHash}`}
        target="_blank" rel="noreferrer noopener">View transaction</a>}
      <button type="button" className="b g sm" onClick={()=>go('Activity')}>All activity</button>
    </div>
  </Celebrate>;
}

const PNL_WINDOWS=[{id:7,label:'7d'},{id:30,label:'30d'},{id:90,label:'90d'},{id:null,label:'All'}];

function PnlCard({summary,sources,pnlView,pnlWindow,onPnlWindow,go}){
  const windows=<div className="seg" role="group" aria-label="P&L window">
    {PNL_WINDOWS.map(option=><button key={option.label} type="button"
      className={pnlWindow===option.id?'on':undefined}
      aria-pressed={pnlWindow===option.id} onClick={()=>onPnlWindow(option.id)}>{option.label}</button>)}
  </div>;
  return <SectionCard title="P&L by day" icon={ICONS.chart} actions={windows}>
    <CardBody source={sources.pnl} skeleton="chart" rows={1}
      empty={pnlView.points.length===0?<EmptyState icon={ICONS.chart} title="No profit or loss yet"
        action={<button type="button" className="b sm" onClick={()=>go('Mint')}>Go to Mint</button>}>
        Once you mint, each day&apos;s net lands here — cost and gas from the confirmed receipt, nothing guessed.
      </EmptyState>:null}>
      <PnlBars points={pnlView.points}/>
      <p className="card-note">Sale proceeds are entered manually — a mint with no recorded sale shows as a loss.</p>
    </CardBody>
  </SectionCard>;
}

function ActivityCard({summary,sources,go}){
  return <SectionCard title="Recent activity" icon={ICONS.clock}
    actions={<button type="button" className="b g sm" onClick={()=>go('Activity')}>View all</button>}>
    <CardBody source={sources.activity} skeleton="row" rows={3}
      empty={summary.activityItems.length===0?<EmptyState icon={ICONS.clock} title="Nothing yet"
        action={<button type="button" className="b sm" onClick={()=>go('Mint')}>Go to Mint</button>}>
        Your first mint will appear here, with its transaction hash and real gas cost.
      </EmptyState>:null}>
      {summary.activityItems.map(item=>{
        // Activity uses `success`/`fail`; transaction-derived rows can use confirmed/submitted.
        // The old "anything except failed" check incorrectly painted `fail` as a green success.
        const success=activitySucceeded(item.status);
        const chain=item.chain||chainFromExplorer(item.explorer);
        const gas=weiToEth(item.actualNetworkCostWei);
        const gasText=gas!==null?gas.toFixed(6):item.txHash?'unavailable':'not spent';
        return <Row key={item.id} icon={success?ICONS.check:ICONS.cross} tone={success?'gain':'loss'}
          title={item.title||'Untitled'}
          sub={<>{item.walletLabel&&<>{item.walletLabel} · </>}{chain&&<><ChainDot chain={chain}/> · </>}
            {item.time?new Date(item.time).toLocaleString():'No timestamp'}</>}
          /* actual_network_cost_wei is GAS ONLY, not the mint price -- labelled so it can
             never be read as the cost of the mint (contract §5.8). */
          valueLabel="gas" value={gasText}/>;
      })}
    </CardBody>
  </SectionCard>;
}

/* --- Right column --------------------------------------------------------- */
function NextDropCard({summary,sources,go}){
  const displayed=summary.nextTask;
  const actions=<button type="button" className="b g sm" onClick={()=>go('Mint','schedule')}>Schedule</button>;
  return <SectionCard title="Next scheduled mint" icon={ICONS.clock}
    actions={actions}>
    <CardBody source={sources.tasks} skeleton="big-value" rows={1}
      empty={!displayed?<EmptyState icon={ICONS.clock} title="Nothing scheduled"
        action={<button type="button" className="b sm" onClick={()=>go('Mint','schedule')}>Schedule a mint</button>}>
        A scheduled mint submits itself at the time you set — it is not a reminder.
      </EmptyState>:null}>
      {displayed&&<CountdownRing target={displayed.mintTime} from={displayed.createdAt}
        title={displayed.name||'Scheduled mint'}
        meta={[displayed.walletLabel,displayed.price?`${displayed.price} ETH`:null]
          .filter(Boolean).join(' · ')||null}/>}
    </CardBody>
  </SectionCard>;
}

function AlertsCard({summary,go}){
  const alerts=[];
  if(summary.failingWatchRules.length)alerts.push({
    key:'watch',
    body:<><b>{summary.failingWatchRules.length} watch {summary.failingWatchRules.length===1?'rule':'rules'} failing.</b>{' '}
      {summary.failingWatchRules.slice(0,2).map(rule=>rule.label||rule.handle||rule.id).join(', ')}</>,
    action:<button type="button" className="b sm" onClick={()=>go('Automation','social')}>Review</button>,
  });
  if(summary.lowBalanceWallets.length)alerts.push({
    key:'balance',
    body:<><b>Low balance.</b> {summary.lowBalanceWallets.map(wallet=>wallet.label).join(', ')} — top up before minting.</>,
    action:<button type="button" className="b sm" onClick={()=>go('Wallets')}>Wallets</button>,
  });
  if(!alerts.length)return null;
  return <>{alerts.map(alert=><div className="alert-note" role="alert" key={alert.key}>
    <span className="alert-icon" aria-hidden="true">{ICONS.alert}</span>
    <div>{alert.body}<div className="alert-actions">{alert.action}</div></div>
  </div>)}</>;
}

const TRIGGER_LABELS={'blockchain-triggered':'sniper','social-triggered':'social'};

function QueueCard({summary,sources,go}){
  return <SectionCard title="Pending queue" icon={ICONS.queue}
    actions={<button type="button" className="b g sm" onClick={()=>go('Activity')}>Activity</button>}>
    <CardBody source={sources.confirmations} skeleton="row" rows={2}
      empty={summary.pendingConfirmations.length===0?<EmptyState icon={ICONS.queue} title="Nothing pending">
        Triggers that need your confirmation before they execute will wait here.
      </EmptyState>:null}>
      <div className="chip-row">{summary.pendingConfirmations.map(item=>
        <span className="chip" key={item.id}>{TRIGGER_LABELS[item.triggerSource]||item.triggerSource||'trigger'}: {item.targetType}</span>)}</div>
    </CardBody>
  </SectionCard>;
}

function WalletsCard({summary,sources,go}){
  return <SectionCard title="Wallets" icon={ICONS.wallet}
    actions={<button type="button" className="b g sm" onClick={()=>go('Wallets')}>Manage</button>}>
    <CardBody source={sources.wallets} skeleton="row" rows={3}
      empty={summary.walletCount===0?<EmptyState icon={ICONS.wallet} title="No wallets yet"
        action={<button type="button" className="b sm" onClick={()=>go('Wallets')}>Create wallet</button>}>
        Create the recommended server-side wallet — the key is generated and encrypted before it ever exists in the open.
      </EmptyState>:null}>
      {summary.walletRows.map(wallet=><Row key={wallet.label} title={wallet.label}
        sub={<span className="mono">{shortAddress(wallet.address)}</span>}
        value={wallet.ethBalance===null?'—':formatEth(wallet.ethBalance)}
        valueTone={wallet.ethBalance!==null&&wallet.ethBalance<0.01?'warn':undefined}/>)}
      {summary.walletCount>summary.walletRows.length
        &&<button type="button" className="b g sm card-more" onClick={()=>go('Wallets')}>
          +{summary.walletCount-summary.walletRows.length} more
        </button>}
    </CardBody>
  </SectionCard>;
}

/* --- Page ----------------------------------------------------------------- */
export default function Home({summary,sources,go,greeting,pnlView,pnl30,pnlWindow,onPnlWindow}){
  // A page-level failure is reported once at the top rather than as six identical card errors.
  // Only genuinely failed sources are listed, and every card keeps its own inline error too, so
  // a single failing endpoint does not blank the page (contract §7.1).
  const failed=Object.entries(sources).filter(([,source])=>source.error);
  // RULE 2: empty is not loading. FirstRun renders only once the wallets fetch has actually
  // ARRIVED and come back empty -- `data !== null` -- so a slow request shows skeletons, never
  // "let's get you minting" to someone who already has three wallets. It also hides itself while
  // that fetch is errored, because a failed load is not evidence of an empty account.
  const walletsArrived=sources.wallets?.data!==null&&sources.wallets?.data!==undefined&&!sources.wallets?.error;
  const firstRun=walletsArrived&&summary.walletCount===0;
  // Which step is "now": no wallet -> 1, wallet but nothing funded -> 2, funded but never minted
  // -> 3. Uses ?? so a real 0 balance counts as arrived-and-zero rather than falsy-and-missing.
  const firstRunStep=summary.walletCount===0?1:(summary.portfolio.eth??0)<=0?2:3;
  return <>
    {/* The prototype's header: "Command centre" eyebrow, the GREETING as the h1 (not the word
        "Home"), and Mint now sitting to its right. The page is named in the rail; repeating it
        as the h1 spends the largest type on the page saying nothing. */}
    <div className="page-head">
      <div className="page-head-text">
        <p className="eyebrow">Command centre</p>
        <h1>{greeting}</h1>
        {/* Prototype: <p class="sub oe"> -- empty state only, verbatim copy. */}
        {firstRun&&<p className="sub">Three steps and you&rsquo;ll have minted your first NFT.</p>}
      </div>
      {/* Prototype home.html: the header action is .of -- it only exists once there is
          something to mint FROM. On first run the sub line replaces it instead. */}
      {!firstRun&&<div className="page-head-actions">
        <button type="button" className="b p" onClick={()=>go('Mint')}>Mint now</button>
      </div>}
    </div>

    {firstRun&&<FirstRun step={firstRunStep} go={go}/>}

    <Tiles summary={summary} sources={sources} pnl30={pnl30}/>

    {failed.length>0&&<Notice error={{
      title:failed.length===Object.keys(sources).length?'Could not load your dashboard.':`Could not load ${failed.length} of ${Object.keys(sources).length} sections.`,
      detail:'Request failed safely — nothing was changed.',
      // Only when every failure agrees on a code. Mixed codes (a 500 alongside a 403) would make
      // one of them a lie, so the page-level notice stays silent and each card shows its own.
      code:[...new Set(failed.map(([,source])=>source.status).filter(Boolean))].length===1
        ?failed.find(([,source])=>source.status)[1].status:undefined,
      onRetry:()=>failed.forEach(([,source])=>source.load()),
    }}/>}

    <div className="split home-split">
      <div className="home-col">
        <CelebrateCard summary={summary} go={go}/>
        <PnlCard summary={summary} sources={sources} pnlView={pnlView}
          pnlWindow={pnlWindow} onPnlWindow={onPnlWindow} go={go}/>
        <ActivityCard summary={summary} sources={sources} go={go}/>
      </div>
      <div className="home-col">
        <NextDropCard summary={summary} sources={sources} go={go}/>
        <AlertsCard summary={summary} go={go}/>
        <WalletsCard summary={summary} sources={sources} go={go}/>
      </div>
    </div>
  </>;
}
