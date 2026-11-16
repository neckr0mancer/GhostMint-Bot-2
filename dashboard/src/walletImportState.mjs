export function walletImportRetryRows(rows,results) {
  const failedByKey=new Map(results
    .filter(result=>result.status==='failed')
    .map(result=>[result.key,result]));

  return rows.flatMap(row=>{
    const failure=failedByKey.get(row.key);
    return failure?[{...row,label:failure.label||row.label}]:[];
  });
}
