const assert=require('node:assert/strict');
const test=require('node:test');

function target({visible=true,attached=true,ariaHidden=false}={}){
  const calls=[];
  return {
    attached,
    hidden:false,
    calls,
    getAttribute:name=>name==='aria-hidden'&&ariaHidden?'true':null,
    getClientRects:()=>visible?[{}]:[],
    focus:options=>calls.push(options),
  };
}

test('modal focus returns to the original visible opener when it is still available',async()=>{
  const {restoreModalFocus}=await import('../dashboard/src/modalFocus.mjs');
  const opener=target();
  const fallback=target();
  const restored=restoreModalFocus(opener,fallback,{contains:element=>element.attached});
  assert.equal(restored,opener);
  assert.deepEqual(opener.calls,[{preventScroll:true}]);
  assert.equal(fallback.calls.length,0);
});

test('modal focus falls back when a breakpoint hides the mobile opener',async()=>{
  const {restoreModalFocus}=await import('../dashboard/src/modalFocus.mjs');
  const hiddenMobileOpener=target({visible:false});
  const visibleDesktopTarget=target();
  const restored=restoreModalFocus(hiddenMobileOpener,visibleDesktopTarget,{contains:element=>element.attached});
  assert.equal(restored,visibleDesktopTarget);
  assert.equal(hiddenMobileOpener.calls.length,0);
  assert.deepEqual(visibleDesktopTarget.calls,[{preventScroll:true}]);
});

test('modal focus does not target detached or hidden fallbacks',async()=>{
  const {restoreModalFocus}=await import('../dashboard/src/modalFocus.mjs');
  const detachedOpener=target({attached:false});
  const hiddenFallback=target({ariaHidden:true});
  const restored=restoreModalFocus(detachedOpener,hiddenFallback,{contains:element=>element.attached});
  assert.equal(restored,null);
  assert.equal(detachedOpener.calls.length,0);
  assert.equal(hiddenFallback.calls.length,0);
});
