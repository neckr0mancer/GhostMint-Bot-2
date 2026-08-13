const DEFAULT_PAGE_SIZE=10;
const MAX_PAGE_SIZE=50;
function pagination(input={}) {
  const page=Number(input.page??1);const pageSize=Number(input.pageSize??DEFAULT_PAGE_SIZE);
  if(!Number.isInteger(page)||page<1) throw new TypeError('page must be a positive integer');
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>MAX_PAGE_SIZE) throw new TypeError(`pageSize must be between 1 and ${MAX_PAGE_SIZE}`);
  return {page,pageSize,offset:(page-1)*pageSize};
}
function paginate(items,input={}) {const p=pagination(input);const total=items.length;return {...p,total,totalPages:Math.max(1,Math.ceil(total/p.pageSize)),items:items.slice(p.offset,p.offset+p.pageSize)};}
module.exports={DEFAULT_PAGE_SIZE,MAX_PAGE_SIZE,paginate,pagination};
