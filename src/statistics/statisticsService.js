function calculateStatistics({activity=[],sniperEvents=[]}) {
  const success=activity.filter(item=>item.status==='success').length;
  const failures=activity.filter(item=>['fail','failed','failure'].includes(item.status)).length;
  const skipped=sniperEvents.filter(item=>item.state==='skipped').length;
  const attempted=success+failures;
  return {success,failures,skipped,attempted,successRate:attempted?Math.round(success/attempted*100):0};
}
module.exports={calculateStatistics};
