import fetch from 'node-fetch';
import stream from 'stream';
import axios from 'axios';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const USER_AGENT = 'validator-images/1.0';
const HTTP_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const CONCURRENCY = 2;
const LIMIT = 100;

async function main() {
  const identitiesSet = new Set();

  const lcds = await getLCDs().catch(err => {
    console.error(`ERROR: Unable to load chain registry LCDs: ${formatErr(err)}`);
    process.exitCode = 1;
    return [];
  });

  for (let i = 0; i < lcds.length; i++) {
    let paginator = '';
    const lcd = lcds[i];
    let page = 1;

    console.log(`Processing validator identities from LCD: ${lcd}`);

    do {
      console.log(`\tPage ${page} processing...`);

      const validatorURL =
        `${lcd}/cosmos/staking/v1beta1/validators?pagination.limit=${LIMIT}${paginator}`;

      let validatorData;

      try {
        validatorData = await fetchJson(validatorURL, { timeoutMs: HTTP_TIMEOUT_MS });
      } catch (err) {
        console.log(`\nERROR: Unable to fetch ${validatorURL}: ${formatErr(err)}\n`);
        break;
      }

      // Validate structure
      if (
        !validatorData ||
        !Array.isArray(validatorData.validators) ||
        !validatorData.pagination
      ) {
        console.log(`\nERROR: ${validatorURL} returned malformed data\n`);
        break;
      }

      // Extract identities safely (dedup + trim).
      for (const v of validatorData.validators) {
        const identity = v?.description?.identity;
        if (!identity) continue;
        const cleaned = String(identity).trim();
        if (cleaned) identitiesSet.add(cleaned);
      }

      // Pagination
      const nextKey = validatorData.pagination.next_key;
      if (nextKey) {
        paginator = `&pagination.key=${encodeURIComponent(nextKey)}`;
        page += 1;
      } else {
        paginator = '';
      }

    } while (paginator);
  }

  const identitiesArray = [...identitiesSet];
  await fs.promises.mkdir('images', { recursive: true });

  console.log('\nInvalid identities will be logged below:');

  const throttler = new Semaphore(CONCURRENCY);
  const tasks = identitiesArray.map(identity => throttler.callFunction(downloadImage, identity));
  const results = await Promise.allSettled(tasks);
  const okCount = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  const failCount = results.filter(r => r.status === 'fulfilled' && r.value === false).length;
  const rejectedCount = results.filter(r => r.status === 'rejected').length;

  console.log(`\nDownload summary: ok=${okCount} failed=${failCount} rejected=${rejectedCount}`);
  if (rejectedCount > 0) process.exitCode = 1;
}

const skippedChainIds = ['localterra', 'neutron-1', 'pion-1'];

async function getLCDs() {
  const chainData = await fetchJson('https://chain-registry.hexxagon.io/chains.json', {
    timeoutMs: HTTP_TIMEOUT_MS,
  });

  const lcds = [];

  for (const networkData of Object.values(
    Object.assign({}, ...Object.values(chainData))
  )) {
    if (!networkData) continue;
    if (skippedChainIds.includes(networkData.chainID)) continue;
    if (networkData.lcd) {
      lcds.push(networkData.lcd);
    }
  }

  return lcds;
}

async function downloadImage(identity) {
  const linkResponse = await getLink(identity);

  if (!linkResponse.filepath) return false;

  if (fs.existsSync(linkResponse.filepath)) return true;

  const finishedDownload = promisify(stream.finished);
  const writer = fs.createWriteStream(linkResponse.filepath);

  try {
    const response = await axiosGetStreamWithRetry(linkResponse.imageURL);

    // Propagate remote stream errors to the writer so `finishedDownload` rejects.
    response.data.on('error', err => writer.destroy(err));

    response.data.pipe(writer);
    await finishedDownload(writer);
    return true;
  } catch (err) {
    const msg = formatAxiosErr(err);
    console.log(`\t${identity} (image download failed: ${msg})`);
    try { writer.destroy(); } catch {}
    return false;
  }
}

async function axiosGetStreamWithRetry(url, attempts = 3) {
  let lastErr;

  for (let i = 1; i <= attempts; i++) {
    try {
      return await axios.get(url, {
        responseType: 'stream',
        timeout: DOWNLOAD_TIMEOUT_MS,
        maxRedirects: MAX_REDIRECTS,
        validateStatus: status => status >= 200 && status < 300,
        headers: {
          'user-agent': USER_AGENT,
        },
      });
    } catch (err) {
      lastErr = err;
      if (!shouldRetryAxios(err) || i === attempts) throw err;
      await sleep(500 * i);
    }
  }

  throw lastErr;
}

function shouldRetryAxios(err) {
  if (!axios.isAxiosError(err)) return false;

  const status = err.response?.status;
  if (status && [429, 500, 502, 503, 504].includes(status)) return true;

  const code = err.code;
  if (!code) return false;
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND'].includes(code);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getLink(identity) {
  let fingerprint;
  let imageURL;

  try {
    const identityURL =
      `https://keybase.io/_/api/1.0/key/fetch.json?pgp_key_ids=${encodeURIComponent(identity)}`;
    const identityData = await fetchJson(identityURL, { timeoutMs: HTTP_TIMEOUT_MS });
    fingerprint = identityData?.keys?.[0]?.fingerprint;
    if (!fingerprint) throw new Error();
  } catch {
    console.log(`\t${identity}`);
    return { filepath: null };
  }

  try {
    const fingerprintURL =
      `https://keybase.io/_/api/1.0/user/lookup.json?key_fingerprint=${encodeURIComponent(fingerprint)}`;
    const fingerprintData = await fetchJson(fingerprintURL, { timeoutMs: HTTP_TIMEOUT_MS });

    imageURL =
      fingerprintData?.them?.['0']?.pictures?.primary?.url ||
      fingerprintData?.them?.pictures?.primary?.url;

    if (!imageURL) throw new Error();
  } catch {
    return { filepath: null };
  }

  const safeIdentity = String(identity).replace(/[^a-zA-Z0-9_-]/g, '_');

  let ext = 'jpg';
  try {
    const u = new URL(imageURL);
    const fromPath = path.extname(u.pathname).toLowerCase().replace(/^\./, '');
    if (fromPath && fromPath.length <= 5) ext = fromPath;
  } catch {}

  // Keep output predictable; avoid writing arbitrary extensions.
  if (!['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) ext = 'jpg';

  return {
    imageURL,
    filepath: path.join('images', `${safeIdentity}.${ext}`),
  };
}

async function fetchJson(url, { timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    try {
      return await res.json();
    } catch {
      throw new Error('Invalid JSON');
    }
  } finally {
    clearTimeout(timer);
  }
}

function formatErr(err) {
  if (!err) return 'unknown error';
  if (err.name === 'AbortError') return 'timeout';
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function formatAxiosErr(err) {
  if (!err) return 'unknown error';
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const code = err.code;
    if (status) return `HTTP ${status}`;
    if (code) return code;
    return err.message || 'axios error';
  }
  return formatErr(err);
}

/* Semaphore for download throttling */
export default class Semaphore {
  constructor(maxConcurrentRequests = 1) {
    this.currentRequests = [];
    this.runningRequests = 0;
    this.maxConcurrentRequests = maxConcurrentRequests;
  }

  callFunction(fnToCall, ...args) {
    return new Promise((resolve, reject) => {
      this.currentRequests.push({ resolve, reject, fnToCall, args });
      this.tryNext();
    });
  }

  tryNext() {
    if (!this.currentRequests.length) return;
    if (this.runningRequests >= this.maxConcurrentRequests) return;

    const { resolve, reject, fnToCall, args } = this.currentRequests.shift();
    this.runningRequests++;

    Promise.resolve()
      .then(() => fnToCall(...args))
      .then(resolve)
      .catch(reject)
      .finally(() => {
        this.runningRequests--;
        this.tryNext();
      });
  }
}

// Only run when invoked as a script (`node index.js`), not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
