function defaultContains(element){
  return typeof document==='undefined'||document.contains(element);
}

export function isVisibleFocusTarget(element,{contains=defaultContains}={}){
  if(!element||typeof element.focus!=='function'||!contains(element))return false;
  if(element.hidden||element.getAttribute?.('aria-hidden')==='true')return false;
  return typeof element.getClientRects!=='function'||element.getClientRects().length>0;
}

export function restoreModalFocus(previouslyFocused,fallback,{contains=defaultContains}={}){
  const target=isVisibleFocusTarget(previouslyFocused,{contains})
    ?previouslyFocused
    :isVisibleFocusTarget(fallback,{contains})?fallback:null;
  target?.focus({preventScroll:true});
  return target;
}
