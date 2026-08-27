const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function formatScheduleDateTime(value){
  const at=value instanceof Date?value:new Date(value);
  if(Number.isNaN(at.getTime()))return '';
  const day=String(at.getUTCDate()).padStart(2,'0');
  const hour=String(at.getUTCHours()).padStart(2,'0');
  const minute=String(at.getUTCMinutes()).padStart(2,'0');
  return `${day} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()} · ${hour}:${minute} UTC`;
}

export function scheduleCountdown(value,now=Date.now()){
  const at=value instanceof Date?value:new Date(value);
  const remaining=at.getTime()-Number(now);
  if(!Number.isFinite(remaining)||remaining<=0)return '';
  const totalMinutes=Math.max(1,Math.ceil(remaining/60_000));
  const days=Math.floor(totalMinutes/1_440);
  const hours=Math.floor((totalMinutes%1_440)/60);
  const minutes=totalMinutes%60;
  if(days)return `${days}d${hours?` ${hours}h`:''}`;
  if(hours)return `${hours}h${minutes?` ${minutes}m`:''}`;
  return `${minutes}m`;
}
