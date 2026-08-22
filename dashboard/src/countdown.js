export function countdownState(target, from, now = Date.now()) {
  const targetMs=new Date(target).getTime();
  if(!Number.isFinite(targetMs))return null;
  const remaining=Math.max(0,targetMs-now);
  const totalSeconds=Math.floor(remaining/1000);
  const days=Math.floor(totalSeconds/86400);
  const hours=Math.floor((totalSeconds%86400)/3600);
  const minutes=Math.floor((totalSeconds%3600)/60);
  const seconds=totalSeconds%60;
  const clock=remaining===0?'due now'
    :days>0?`${days}d ${hours}h`
    :Math.floor(totalSeconds/3600)>0
      ?`${Math.floor(totalSeconds/3600)}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`
      :`${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
  const startMs=from?new Date(from).getTime():NaN;
  const span=Number.isFinite(startMs)&&targetMs>startMs?targetMs-startMs:60*60*1000;
  const progress=Math.min(1,Math.max(0,1-remaining/span));
  return {targetMs,remaining,clock,progress};
}
