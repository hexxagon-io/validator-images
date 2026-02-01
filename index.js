import fetch from 'node-fetch';
import stream from 'stream';
import axios from 'axios';
import { promisify } from 'util';
import fs from 'fs';

main().catch(console.error);

async function main() {
  const limit = 100;

  let identitiesArray = [];
  const identitiesSet = new Set();

  const lcds = await getLCDs();

  for (let i = 0; i < lcds.length; i++) {
    let paginator = '';
    const lcd = lcds[i];
    let page = 1;

    console.log(`Processing validator identities from LCD: ${lcd}`);

    do {
      console.log(`\tPage ${page} processing...`);

      const validatorURL =
        `${lcd}/cosmos/staking/v1beta1/validators?pagination.limit=${limit}${paginator}`;

      let validatorResponse;
      let validatorData;

      // Fetch
      try {
        validatorResponse = await fetch(validatorURL);
      } catch {
        console.log(`\nERROR: Unable to fetch ${validatorURL}\n`);
        break;
      }

      // Parse JSON
      try {
        validatorData = await validatorResponse.json();
      } catch {
        console.log(`\nERROR: ${validatorURL} returned invalid JSON\n`);
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

      // Extract identities safely
      identitiesArray = validatorData.validators
        .map(v => v?.description?.identity)
        .filter(Boolean);

      identitiesArray.forEach(identitiesSet.add, identitiesSet);

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

  // Clean identities
  identitiesArray = [...identitiesSet].filter(id => id.trim() !== '');

  console.log('\nInvalid identities will be logged below:');

  const throttler = new Semaphore(2);
  identitiesArray.forEach(identity => {
    throttler.callFunction(downloadImage, identity);
  });
}

const skippedChainIds = ['localterra', 'neutron-1', 'pion-1'];

async function getLCDs() {
  const chainResponse = await fetch('https://chain-registry.hexxagon.io/chains.json');
  const chainData = await chainResponse.json();

  const lcds = [];

  for (const networkData of Object.values(
    Object.assign({}, ...Object.values(chainData))
  )) {
    if (!skippedChainIds.includes(networkData.chainID)) {
      lcds.push(networkData.lcd);
    }
  }

  return lcds;
}

async function downloadImage(identity) {
  const linkResponse = await getLink(identity);

  if (!linkResponse.filepath) return;

  const finishedDownload = promisify(stream.finished);
  const writer = fs.createWriteStream(linkResponse.filepath);

  const response = await axios({
    method: 'GET',
    url: linkResponse.imageURL,
    responseType: 'stream',
    followRedirect: false,
  });

  response.data.pipe(writer);
  await finishedDownload(writer);
}

async function getLink(identity) {
  let fingerprint;
  let imageURL;

  try {
    const identityURL =
      `https://keybase.io/_/api/1.0/key/fetch.json?pgp_key_ids=${identity}`;
    const identityResponse = await fetch(identityURL);
    const identityData = await identityResponse.json();
    fingerprint = identityData?.keys?.[0]?.fingerprint;
    if (!fingerprint) throw new Error();
  } catch {
    console.log(`\t${identity}`);
    return { filepath: null };
  }

  try {
    const fingerprintURL =
      `https://keybase.io/_/api/1.0/user/lookup.json?key_fingerprint=${fingerprint}`;
    const fingerprintResponse = await fetch(fingerprintURL);
    const fingerprintData = await fingerprintResponse.json();

    imageURL =
      fingerprintData?.them?.['0']?.pictures?.primary?.url ||
      fingerprintData?.them?.pictures?.primary?.url;

    if (!imageURL) throw new Error();
  } catch {
    return { filepath: null };
  }

  const ext = imageURL.split('.').pop();
  return {
    imageURL,
    filepath: `./images/${identity}.${ext}`,
  };
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

    fnToCall(...args)
      .then(resolve)
      .catch(reject)
      .finally(() => {
        this.runningRequests--;
        this.tryNext();
      });
  }
}
