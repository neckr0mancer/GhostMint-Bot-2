const assert = require('node:assert/strict');
const test = require('node:test');
const { createSocialUsageService, formatUsageSummary } = require('../src/social/usageService');

test('owner usage report aggregates actual rows and compares configurable pricing models', async () => {
  const callers=[];
  const service=createSocialUsageService({
    governance:{requireOwner:async id=>callers.push(id)}, now:()=>Date.UTC(2026,7,15),
    repository:{usageSince:async()=>[
      {ruleId:'1',ruleName:'X drops',method:'official_api',requestType:'read',requests:1000,reportedCostUsd:5,reportedCredits:1000},
      {ruleId:'2',ruleName:'Managed Discord',method:'managed_service',requestType:'read',requests:200,reportedCostUsd:0,reportedCredits:200},
      {ruleId:'3',ruleName:'Free scrape',method:'scraper',requestType:'read',requests:50,reportedCostUsd:0,reportedCredits:0},
    ]}, pricing:{officialReadUsd:0.005,officialPostUsd:0.015,managedMonthlyTiersUsd:[199,499]},
  });
  const summary=await service.summary('owner','month');
  assert.deepEqual(callers,['owner']);
  assert.equal(summary.requests,1250);
  assert.equal(summary.payPerUseEstimateUsd,6.25);
  assert.deepEqual(summary.breakEvenRequests.map(value=>value.atReadRate),[39800,99800]);
  assert.match(formatUsageSummary(summary),/X drops.*official_api.*1000/);
});

test('usage reporting remains owner-only', async () => {
  const service=createSocialUsageService({governance:{requireOwner:async()=>{throw new Error('Owner access required');}},
    repository:{usageSince:async()=>[]},pricing:{officialReadUsd:0.005,officialPostUsd:0.015,managedMonthlyTiersUsd:[199]}});
  await assert.rejects(service.summary('regular','today'),/Owner access required/);
});
