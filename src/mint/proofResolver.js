const net = require('node:net');
const { Buffer } = require('node:buffer');
const { URL } = require('node:url');
const axios = require('axios');
const { getMintMethod } = require('./mintRegistry');

class ProofResolutionError extends Error {
  constructor(message, cause) {
    super(`${message} Enter the proof or signature manually; minting did not proceed.`);
    this.name = 'ProofResolutionError';
    this.code = 'MANUAL_AUTHORIZATION_REQUIRED';
    this.cause = cause;
  }
}

function isPrivateHostname(hostname) {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.local')) return true;
  if (net.isIP(normalized) === 4) {
    const [a, b] = normalized.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return net.isIP(normalized) === 6 && (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80'));
}

function publicProofUrl(source, walletAddress, ipfsGateway = 'https://ipfs.io/ipfs/') {
  const raw = String(source || '').trim();
  const expanded = raw.startsWith('ipfs://') ? `${ipfsGateway.replace(/\/?$/, '/')}${raw.slice(7)}` : raw;
  let url;
  try { url = new URL(expanded.replaceAll('{address}', walletAddress)); }
  catch { throw new ProofResolutionError('The proof URL is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isPrivateHostname(url.hostname)) {
    throw new ProofResolutionError('The proof URL must be a public HTTP, HTTPS, or IPFS resource.');
  }
  if (!raw.includes('{address}') && !url.searchParams.has('address')) url.searchParams.set('address', walletAddress);
  return url.toString();
}

function addressValue(object, walletAddress) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return undefined;
  const key = Object.keys(object).find(candidate => candidate.toLowerCase() === walletAddress.toLowerCase());
  return key ? object[key] : undefined;
}

function extractAuthorization(payload, kind, walletAddress) {
  const body = payload?.data === undefined ? payload : payload.data;
  const walletEntry = addressValue(body, walletAddress) ?? addressValue(body?.allowlist, walletAddress);
  const candidate = walletEntry?.[kind] ?? walletEntry ?? body?.[kind] ?? body?.data?.[kind];
  if (kind === 'proof') {
    if (!Array.isArray(candidate) || candidate.length === 0) throw new ProofResolutionError('The allowlist response did not contain a non-empty proof.');
  } else if (typeof candidate !== 'string' || candidate === '' || candidate === '0x') {
    throw new ProofResolutionError('The allowlist response did not contain a non-empty signature.');
  }
  return candidate;
}

function createProofResolver({ fetchJson, ipfsGateway } = {}) {
  const fetcher = fetchJson || (async url => axios.get(url, {
    timeout: 10_000,
    maxContentLength: 1_000_000,
    maxRedirects: 0,
    responseType: 'json',
    validateStatus: status => status >= 200 && status < 300,
  }));
  return {
    async resolve({ methodSignature, arguments: original = [], proofUrl, walletAddress, manualAuthorization }) {
      const method = getMintMethod(methodSignature);
      if (!method) return original;
      const authorizationIndex = method.inputs.findIndex(input => input.authorization);
      if (authorizationIndex < 0) {
        if (proofUrl) throw new ProofResolutionError('This mint method does not accept an allowlist proof or signature.');
        return original;
      }
      const args = [...original];
      if (manualAuthorization !== undefined && manualAuthorization !== null) {
        let value = Buffer.isBuffer(manualAuthorization) ? manualAuthorization.toString('utf8') : manualAuthorization;
        if (method.inputs[authorizationIndex].authorization === 'proof' && typeof value === 'string') {
          try { value = JSON.parse(value); }
          catch (error) { throw new ProofResolutionError('The uploaded proof is not a valid JSON array.', error); }
        } else if (typeof value === 'string') value = value.trim();
        if (args.length === method.inputs.length - 1) args.splice(authorizationIndex, 0, value);
        else if (args.length === method.inputs.length) args[authorizationIndex] = value;
        else throw new ProofResolutionError(`The mint requires ${method.inputs.length} arguments.`);
        return args;
      }
      if (!proofUrl) return args;
      const url = publicProofUrl(proofUrl, walletAddress, ipfsGateway);
      let response;
      try { response = await fetcher(url); }
      catch (error) { throw new ProofResolutionError('Automatic allowlist lookup failed.', error); }
      const value = extractAuthorization(response, method.inputs[authorizationIndex].authorization, walletAddress);
      if (args.length === method.inputs.length - 1) args.splice(authorizationIndex, 0, value);
      else if (args.length === method.inputs.length) args[authorizationIndex] = value;
      else throw new ProofResolutionError(`The mint requires ${method.inputs.length} arguments.`);
      return args;
    },
  };
}

module.exports = { ProofResolutionError, createProofResolver, extractAuthorization, publicProofUrl };
