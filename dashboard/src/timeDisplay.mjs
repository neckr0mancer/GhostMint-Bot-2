export const TIME_FORMATS=Object.freeze(['12h','24h']);

export function normalizeTimeFormat(value){
  return value==='12h'?'12h':'24h';
}

export function hourCycleOptions(timeFormat){
  return normalizeTimeFormat(timeFormat)==='12h'?{hour12:true}:{hourCycle:'h23'};
}

export function formatDashboardDateTime(value,{timeFormat='24h',locale,timeZone,
  seconds=false,fallback='Time unavailable',...options}={}){
  const date=value instanceof Date?value:new Date(value);
  if(Number.isNaN(date.getTime()))return fallback;
  return new Intl.DateTimeFormat(locale,{
    year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',
    ...(seconds?{second:'2-digit'}:{}),...hourCycleOptions(timeFormat),
    ...(timeZone?{timeZone}:{}),...options,
  }).format(date);
}

export function formatDashboardTime(value,{timeFormat='24h',locale,timeZone,
  seconds=false,fallback='Time unavailable'}={}){
  const date=value instanceof Date?value:new Date(value);
  if(Number.isNaN(date.getTime()))return fallback;
  return new Intl.DateTimeFormat(locale,{
    hour:'numeric',minute:'2-digit',...(seconds?{second:'2-digit'}:{}),
    ...hourCycleOptions(timeFormat),...(timeZone?{timeZone}:{}),
  }).format(date);
}
