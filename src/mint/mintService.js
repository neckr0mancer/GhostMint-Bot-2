const { isAddress } = require('ethers');
const { ValidationError } = require('../validation/domain');
const { buildMintCall } = require('./mintCall');
const { getMintMethod } = require('./mintRegistry');
const { runAllowlistCheck, validateAllowlistCheck } = require('./allowlistCheckRegistry');

function invalid(field, message) { throw new ValidationError({ field, message }); }
function presetName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) invalid('name', 'must be 1-64 safe characters');
  return name;
}

function serializableArguments(values) {
  return values.map(value => typeof value === 'bigint' ? value.toString() : value);
}

function abiMatches(method, fragment) {
  return fragment?.type === 'function' && fragment.name === 'mint'
    && fragment.stateMutability === 'payable' && Array.isArray(fragment.inputs)
    && fragment.inputs.length === method.fragment.inputs.length
    && fragment.inputs.every((input, index) => input.name === method.fragment.inputs[index].name
      && input.type === method.fragment.inputs[index].type);
}

function createMintService({ presetRepository, proofResolver, supportedChains, providerService }) {
  async function prepare(input) {
    if (!supportedChains.includes(input.chain)) invalid('chain', `must be one of: ${supportedChains.join(', ')}`);
    if (!isAddress(input.walletAddress)) invalid('walletAddress', 'must be a valid Ethereum address');
    const allowlistCheck=validateAllowlistCheck(input.allowlistCheck);
    if (allowlistCheck) await runAllowlistCheck({check:allowlistCheck,chain:input.chain,
      contractAddress:input.contractAddress,walletAddress:input.walletAddress,providerService});
    const resolvedArguments = await proofResolver.resolve(input);
    return { ...buildMintCall({ ...input, arguments: resolvedArguments }), chain: input.chain, allowlistCheck };
  }

  return {
    prepare,

    async savePreset(userId, input) {
      const prepared = await prepare(input);
      return presetRepository.save({
        userId,
        name: presetName(input.name),
        contractAddress: prepared.preview.contractAddress,
        chain: input.chain,
        methodSignature: prepared.method.signature,
        abiFragment: prepared.abiFragment,
        arguments: serializableArguments(input.arguments || []),
        valueWei: prepared.valueWei,
        proofUrl: input.proofUrl || null,
        allowlistCheck: prepared.allowlistCheck,
      });
    },

    async preparePreset(userId, name, walletAddress) {
      const preset = await presetRepository.getByName(userId, presetName(name));
      if (!preset) invalid('preset', 'was not found');
      const method = getMintMethod(preset.methodSignature);
      if (!method || !abiMatches(method, preset.abiFragment)) {
        invalid('preset', 'contains an unsupported or altered ABI fragment');
      }
      return prepare({
        contractAddress: preset.contractAddress,
        methodSignature: preset.methodSignature,
        arguments: preset.arguments,
        walletAddress,
        valueWei: preset.valueWei,
        proofUrl: preset.proofUrl,
        allowlistCheck: preset.allowlistCheck,
        chain: preset.chain,
      });
    },

    listPresets: userId => presetRepository.list(userId),
    deletePreset: (userId, name) => presetRepository.delete(userId, presetName(name)),
  };
}

module.exports = { abiMatches, createMintService, presetName, serializableArguments };
