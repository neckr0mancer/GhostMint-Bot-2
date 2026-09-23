const DETECTED_STAGE_BUFFER_MS=15_000;

// datetime-local has no timezone marker. Convert an absolute provider timestamp into the user's
// local wall-clock value while retaining seconds; dropping them can move the submitted mint time
// before a stage that opens at (for example) 04:00:20Z.
export function stageMintTimeLocalValue(stageStartSeconds,{bufferMs=DETECTED_STAGE_BUFFER_MS}={}){
  const stageStartMs=Number(stageStartSeconds)*1000;
  const delay=Number(bufferMs);
  if(!Number.isFinite(stageStartMs)||!Number.isFinite(delay)||delay<0)return '';
  const target=new Date(stageStartMs+delay);
  const localWallClock=new Date(target.getTime()-(target.getTimezoneOffset()*60_000));
  return localWallClock.toISOString().slice(0,19);
}
