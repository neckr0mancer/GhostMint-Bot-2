// Shared activity-feed semantics. Both the live refresh event list and status interpretation live
// outside React so they can be tested without a browser or JSX transform.
export const ACTIVITY_EVENTS=['activity.changed','snipers.changed','tasks.changed','watchrules.changed','wallets.changed'];

const SUCCESS_STATUSES=new Set(['success','confirmed','submitted','executed','resolved']);

export function activitySucceeded(status){
  return SUCCESS_STATUSES.has(String(status||'').toLowerCase());
}
