export function formatWhen(value){if(!value)return 'No timestamp';const date=new Date(value);return Number.isNaN(date.getTime())?'No timestamp':date.toLocaleString();}
export function formatAmount(value,suffix=''){const parsed=Number(value);return `${Number.isFinite(parsed)?parsed.toFixed(4):'0.0000'}${suffix}`;}
