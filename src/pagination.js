const { ValidationError } = require('./validation/domain');

const DEFAULT_PAGE_SIZE=10;
const MAX_PAGE_SIZE=50;
// page and pageSize arrive straight off a query string, so an out-of-range value is a CLIENT
// mistake, not a server fault. These used to throw a bare TypeError, which no layer recognised:
// the dashboard's catch-all turned it into HTTP 500 {"error":"Request failed safely"}, so
// ?pageSize=100 looked identical to the database being down and named nothing the caller could
// fix. ValidationError is what every other request error raises, so the API answers 400 with the
// offending field (src/dashboard/api.js `action` -> sendValidationError), and the Telegram and
// Discord layers render it through validationReply instead of dying on an unhandled throw.
function invalid(field,message){throw new ValidationError({field,message});}
function pagination(input={}) {
  const page=Number(input.page??1);const pageSize=Number(input.pageSize??DEFAULT_PAGE_SIZE);
  if(!Number.isInteger(page)||page<1) invalid('page','must be a positive integer');
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>MAX_PAGE_SIZE) invalid('pageSize',`must be between 1 and ${MAX_PAGE_SIZE}`);
  return {page,pageSize,offset:(page-1)*pageSize};
}
function paginate(items,input={}) {const p=pagination(input);const total=items.length;return {...p,total,totalPages:Math.max(1,Math.ceil(total/p.pageSize)),items:items.slice(p.offset,p.offset+p.pageSize)};}
module.exports={DEFAULT_PAGE_SIZE,MAX_PAGE_SIZE,paginate,pagination};
