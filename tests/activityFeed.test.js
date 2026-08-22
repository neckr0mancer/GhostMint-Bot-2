const test=require('node:test');
const assert=require('node:assert');
const path=require('node:path');
const {pathToFileURL}=require('node:url');

const load=()=>import(pathToFileURL(path.join(__dirname,'..','dashboard','src','activityFeed.js')).href);

test('Home listens for direct activity writes as well as source-specific refreshes',async()=>{
  const {ACTIVITY_EVENTS}=await load();
  assert.ok(ACTIVITY_EVENTS.includes('activity.changed'),
    'recordMintActivity broadcasts activity.changed, so omitting it leaves Home stale');
});

test('fail and failed activity are both rendered as failures',async()=>{
  const {activitySucceeded}=await load();
  assert.equal(activitySucceeded('success'),true);
  assert.equal(activitySucceeded('confirmed'),true);
  assert.equal(activitySucceeded('fail'),false);
  assert.equal(activitySucceeded('failed'),false);
  assert.equal(activitySucceeded(null),false);
});
