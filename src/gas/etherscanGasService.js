const axios = require('axios');

class GasLookupError extends Error {
  constructor(code, message) { super(message); this.name='GasLookupError'; this.code=code; }
}

function numeric(value, field) {
  const parsed=Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new GasLookupError('INVALID_RESPONSE', `Etherscan returned an invalid ${field}`);
  return parsed;
}

function createEtherscanGasService({ apiKey, chains, timeoutMs=10_000,
  endpoint='https://api.etherscan.io/v2/api', http=axios }) {
  return {
    async lookup(chain) {
      const definition=chains[chain];
      if (!definition) throw new GasLookupError('UNSUPPORTED_CHAIN','Gas lookup is unavailable for that chain');
      if (!apiKey) throw new GasLookupError('MISSING_API_KEY','Gas lookup is unavailable until ETHERSCAN_API_KEY is configured');
      try {
        const response=await http.get(endpoint,{timeout:timeoutMs,params:{chainid:String(definition.chainId),module:'gastracker',action:'gasoracle',apikey:apiKey}});
        if (String(response.data?.status) !== '1' || !response.data?.result || typeof response.data.result !== 'object') {
          throw new GasLookupError('PROVIDER_ERROR','Etherscan could not provide gas prices right now');
        }
        const result=response.data.result;
        return {chain,chainId:definition.chainId,safeGasPriceGwei:numeric(result.SafeGasPrice,'safe gas price'),
          gasPriceGwei:numeric(result.ProposeGasPrice,'proposed gas price'),
          maxFeePerGasGwei:numeric(result.FastGasPrice,'fast gas price'),source:'etherscan-v2'};
      } catch (error) {
        if (error instanceof GasLookupError) throw error;
        throw new GasLookupError(error?.code==='ECONNABORTED'?'TIMEOUT':'UNAVAILABLE','Gas lookup is temporarily unavailable');
      }
    },
  };
}

module.exports={GasLookupError,createEtherscanGasService};
