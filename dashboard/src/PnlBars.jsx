import React from 'react';
import {pnlBarLayout} from './pnlChart.js';

const CHART_WIDTH=620;
const CHART_HEIGHT=112;
const BAR_RADIUS=4;

function signed(value,digits=3){
  const parsed=Number(value);
  if(!Number.isFinite(parsed))return '—';
  const fixed=Math.abs(parsed).toFixed(digits);
  if(Number(fixed)===0)return `0.${'0'.repeat(digits)}`;
  return `${parsed<0?'−':'+'}${fixed}`;
}

// Only the data-end is rounded; the baseline end stays square so each bar remains visibly
// anchored to the shared zero line.
function barPath(x,width,baseline,end,radius){
  const height=Math.abs(end-baseline);
  if(height===0)return '';
  const r=Math.max(0,Math.min(radius,height,width/2));
  const up=end<baseline;
  const tip=up?baseline-height:baseline+height;
  const inner=up?tip+r:tip-r;
  return `M ${x} ${baseline} L ${x} ${inner} Q ${x} ${tip} ${x+r} ${tip} L ${x+width-r} ${tip} Q ${x+width} ${tip} ${x+width} ${inner} L ${x+width} ${baseline} Z`;
}

export default function PnlBars({points=[],className='pnl-chart',showLegend=true}){
  if(!points.length)return null;
  const {baseline,bars}=pnlBarLayout(points,{width:CHART_WIDTH,height:CHART_HEIGHT});
  const total=points.reduce((sum,point)=>sum+point.net,0);
  const days=new Set(points.map(point=>point.day)).size;
  return <>
    <svg className={className} viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" role="img"
      aria-label={`${points.length} recorded P&L ${points.length===1?'outcome':'outcomes'} across ${days} ${days===1?'day':'days'}. Net ${signed(total)} ETH.`}>
      <line x1="0" y1={baseline} x2={CHART_WIDTH} y2={baseline} stroke="var(--border-strong)" strokeWidth="1"/>
      <g>{bars.map(bar=><path key={bar.id} d={barPath(bar.x,bar.width,baseline,bar.end,BAR_RADIUS)}
        fill={bar.net<0?'var(--loss)':'var(--gain)'}>
        <title>{`${bar.day} · ${bar.label}: ${signed(bar.net)} ETH`}</title>
      </path>)}</g>
    </svg>
    {showLegend&&<div className="chart-legend">
      <span><i className="swatch" style={{background:'var(--gain)'}} aria-hidden="true"/> Gain · above baseline · <b>+</b></span>
      <span><i className="swatch" style={{background:'var(--loss)'}} aria-hidden="true"/> Loss · below baseline · <b>−</b></span>
    </div>}
  </>;
}
