// The database remains the durable source of truth for dashboard appearance. This module stores
// only an account-scoped change that could not be synchronized yet, so an already-loaded dashboard
// can still switch themes while its network connection is down.
export const DASHBOARD_THEMES=Object.freeze([
  'ghost-mint',
  'ghost-mint-light',
  'clean-vault',
  'neon-arcade',
  'quiet-ledger',
]);

export const DEFAULT_DASHBOARD_THEME='ghost-mint';

const themeSet=new Set(DASHBOARD_THEMES);
const pendingThemePrefix='ghostmint-theme-pending:';

export function isDashboardTheme(value){
  return typeof value==='string'&&themeSet.has(value);
}

function pendingThemeKey(userId){
  const normalized=String(userId??'').trim();
  return normalized?`${pendingThemePrefix}${normalized}`:null;
}

function resolvedStorage(storage){
  if(storage!==undefined)return storage;
  try{return globalThis.localStorage;}
  catch{return null;}
}

export function readPendingTheme(userId,storage){
  const key=pendingThemeKey(userId);
  if(!key)return null;
  try{
    const value=resolvedStorage(storage)?.getItem(key);
    return isDashboardTheme(value)?value:null;
  }catch{return null;}
}

export function savePendingTheme(userId,theme,storage){
  const key=pendingThemeKey(userId);
  if(!key||!isDashboardTheme(theme))return false;
  try{
    const target=resolvedStorage(storage);
    if(!target)return false;
    target.setItem(key,theme);
    return true;
  }catch{return false;}
}

// A save request can finish after the user has selected a newer theme. Clear only the value that
// the completed request actually persisted; leaving a newer value in place lets the next flush
// synchronize it and prevents out-of-order requests from winning.
export function clearPendingTheme(userId,persistedTheme,storage){
  const key=pendingThemeKey(userId);
  if(!key||!isDashboardTheme(persistedTheme))return false;
  const target=resolvedStorage(storage);
  if(!target)return false;
  try{
    if(target.getItem(key)!==persistedTheme)return false;
    target.removeItem(key);
    return true;
  }catch{return false;}
}

export function resolveDashboardTheme(userId,serverTheme,storage){
  return readPendingTheme(userId,storage)
    ||(isDashboardTheme(serverTheme)?serverTheme:DEFAULT_DASHBOARD_THEME);
}
