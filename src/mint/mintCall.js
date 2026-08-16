const { formatEther, isAddress } = require('ethers');
const { ValidationError } = require('../validation/domain');
const { MINT_METHODS, getMintMethod } = require('./mintRegistry');

const UINT256_MAX = 2n ** 256n - 1n;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;
const HEX_BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function invalid(field, message) { throw new ValidationError({ field, message }); }

function uint256(value, input, index) {
  if (typeof value === 'boolean' || !/^(0|[1-9]\d*)$/.test(String(value))) invalid(`arguments[${index}]`, `${input.name} must be an unsigned integer`);
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX || (input.role === 'amount' && (parsed < 1n || parsed > 100n))) {
    invalid(`arguments[${index}]`, input.role === 'amount' ? `${input.name} must be between 1 and 100` : `${input.name} exceeds uint256`);
  }
  return parsed;
}

function bytes(value, input, index) {
  if (typeof value !== 'string' || !HEX_BYTES.test(value) || (!input.emptyAllowed && value === '0x')) {
    invalid(`arguments[${index}]`, `${input.name} must be non-empty even-length hexadecimal bytes`);
  }
  return value;
}

function proof(value, input, index) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { invalid(`arguments[${index}]`, `${input.name} must be a JSON array of bytes32 values`); }
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 256 || parsed.some(item => typeof item !== 'string' || !HEX_BYTES32.test(item))) {
    invalid(`arguments[${index}]`, `${input.name} must contain 1-256 bytes32 hex values`);
  }
  return parsed;
}

function validateArguments(method, values, walletAddress) {
  if (!Array.isArray(values)) invalid('arguments', 'must be an array');
  if (values.length !== method.inputs.length) invalid('arguments', `must contain exactly ${method.inputs.length} values for ${method.signature}`);
  return method.inputs.map((input, index) => {
    const raw = values[index] === '$wallet' ? walletAddress : values[index];
    if (input.type === 'address') {
      if (!isAddress(raw)) invalid(`arguments[${index}]`, `${input.name} must be a valid Ethereum address`);
      return raw;
    }
    if (input.type === 'uint256') return uint256(raw, input, index);
    if (input.type === 'bytes32[]') return proof(raw, input, index);
    if (input.type === 'bytes') return bytes(raw, input, index);
    invalid(`arguments[${index}]`, `unsupported built-in argument type ${input.type}`);
  });
}

function previewValue(input, value) {
  if (input.type === 'bytes32[]') return `${value.length} proof node${value.length === 1 ? '' : 's'} present`;
  if (input.authorization === 'signature') return `signature present (${(value.length - 2) / 2} bytes)`;
  if (input.type === 'bytes') return value === '0x' ? 'empty bytes' : `${(value.length - 2) / 2} bytes`;
  return value.toString();
}

function buildMintCall({ contractAddress, methodSignature, arguments: values = [], walletAddress, valueWei = 0n }) {
  if (!isAddress(contractAddress)) invalid('contractAddress', 'must be a valid Ethereum address');
  const method = getMintMethod(methodSignature);
  if (!method) invalid('methodSignature', 'is not one of the supported mint signatures');
  let nativeValue;
  try { nativeValue = BigInt(valueWei); } catch { invalid('valueWei', 'must be a non-negative integer amount in wei'); }
  if (nativeValue < 0n || nativeValue > 10n ** 78n - 1n) invalid('valueWei', 'must be a non-negative database-safe integer amount in wei');
  const args = validateArguments(method, values, walletAddress);
  let calldata;
  try { calldata = method.iface.encodeFunctionData('mint', args); }
  catch { invalid('arguments', `could not be encoded for ${method.signature}`); }
  const decoded = method.iface.decodeFunctionData('mint', calldata);
  const preview = {
    contractAddress,
    methodSignature: method.signature,
    standard: method.standard,
    arguments: method.inputs.map((input, index) => ({ name: input.name, type: input.type, value: previewValue(input, decoded[index]) })),
    nativeValueWei: nativeValue.toString(),
    nativeValue: formatEther(nativeValue),
  };
  return { abiFragment: method.fragment, arguments: args, calldata, method, preview, valueWei: nativeValue };
}

function decodeMintCall({ contractAddress, calldata, valueWei = 0n }) {
  if (!isAddress(contractAddress)) invalid('contractAddress', 'must be a valid Ethereum address');
  if (typeof calldata !== 'string' || !HEX_BYTES.test(calldata) || calldata.length < 10) invalid('calldata', 'must be encoded hexadecimal function calldata');
  const selector=calldata.slice(0,10).toLowerCase();
  const method=Object.values(MINT_METHODS).find(candidate=>candidate.iface.getFunction('mint').selector.toLowerCase()===selector);
  if (!method) invalid('calldata', 'does not match a supported Milestone 8 mint signature');
  let nativeValue;
  try { nativeValue=BigInt(valueWei); } catch { invalid('valueWei', 'must be a non-negative integer amount in wei'); }
  if (nativeValue<0n) invalid('valueWei', 'must be a non-negative integer amount in wei');
  let decoded;
  try { decoded=method.iface.decodeFunctionData('mint',calldata); }
  catch { invalid('calldata', `could not be decoded as ${method.signature}`); }
  return {contractAddress,methodSignature:method.signature,standard:method.standard,
    arguments:method.inputs.map((input,index)=>({name:input.name,type:input.type,value:previewValue(input,decoded[index])})),
    nativeValueWei:nativeValue.toString(),nativeValue:formatEther(nativeValue)};
}

function formatMintPreview(preview) {
  const args = preview.arguments.length
    ? preview.arguments.map(item => `• ${item.name}: ${item.value}`).join('\n')
    : '• No arguments';
  const callTargetLine = preview.callTarget && preview.callTarget !== preview.contractAddress
    ? `\nCall target: ${preview.callTarget}` : '';
  return `Mint preview\nContract: ${preview.contractAddress}${callTargetLine}\nMethod: ${preview.methodSignature}\nStandard: ${preview.standard}\n${args}\nNative value: ${preview.nativeValue}`;
}

module.exports = { buildMintCall, decodeMintCall, formatMintPreview, validateArguments };
