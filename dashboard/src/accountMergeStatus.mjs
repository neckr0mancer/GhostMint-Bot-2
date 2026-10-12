const UNIFIED_TEXT='Unified: both platforms already read and write the same account.';
const SPLIT_TEXT='Split account detected: these identities currently map to different GhostMint accounts.';

export function accountMergeStatus({
  sourcePlatformUserId='',
  targetPlatformUserId='',
  matchedSource=null,
  matchedTarget=null,
}={}){
  const sameAccount=Boolean(matchedSource&&matchedTarget
    &&matchedSource.userId===matchedTarget.userId);
  const disabledReason=!sourcePlatformUserId.trim()
    ?"Enter the duplicate's platform user ID first."
    :!matchedSource
      ?'No registered user found for the duplicate platform and ID.'
      :!targetPlatformUserId.trim()
        ?'Enter the platform user ID to keep first.'
        :!matchedTarget
          ?'No registered user found for the platform and ID to keep.'
          :'';
  const notice=matchedSource&&matchedTarget
    ?{tone:sameAccount?'i':'w',text:sameAccount?UNIFIED_TEXT:SPLIT_TEXT}
    :null;
  return {sameAccount,disabledReason,notice};
}
