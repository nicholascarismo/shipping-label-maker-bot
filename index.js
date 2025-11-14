import 'dotenv/config';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import express from 'express';
import boltPkg from '@slack/bolt';
import fetch from 'node-fetch';

const { App } = boltPkg;

/* =========================
   Env & Config
========================= */

const {
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,       // xapp-... (Socket Mode app-level token)
  SLACK_SIGNING_SECRET,  // not strictly required for Socket Mode, but we keep it wired
  WATCH_CHANNEL_ID,      // optional: default channel to post into
  PORT,                  // Express port (healthcheck / future webhooks)
  SHIPPO_API_TOKEN       // Shippo API token (test or live)
} = process.env;

function mustHave(name) {
  if (!process.env[name] || String(process.env[name]).trim() === '') {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
}

mustHave('SLACK_BOT_TOKEN');
mustHave('SLACK_APP_TOKEN');
mustHave('SHIPPO_API_TOKEN');

/* =========================
   Paths & Persistence (./data)
========================= */

const DATA_DIR = path.resolve('./data');
const COMMAND_LOG_PATH = path.join(DATA_DIR, 'commands-log.json'); // [{ type, userId, channelId, text, ts }, ...]

async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    const txt = await fsp.readFile(file, 'utf8');
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * Append a command usage record to ./data/commands-log.json,
 * capped to the most recent 1000 entries for safety.
 */
async function appendCommandLog(entry) {
  try {
    await ensureDataDir();
    const current = await readJson(COMMAND_LOG_PATH, []);
    current.push(entry);
    const MAX_RECORDS = 1000;
    const trimmed = current.length > MAX_RECORDS ? current.slice(current.length - MAX_RECORDS) : current;
    await writeJsonAtomic(COMMAND_LOG_PATH, trimmed);
  } catch (e) {
    console.warn('⚠️ Failed to append command log:', e?.stack || e?.message || e);
  }
}

const DEFAULT_FROM_ADDRESS_TEXT = `Carismo Design
71 Winant Place (Suite B)
Staten Island, NY 10309`;

const DEFAULT_TO_ADDRESS_TEXT = `Returns Department
Carismo Design
71 Winant Place (Suite B)
Staten Island, NY 10309`;

const DEFAULT_PARCEL = {
  length: '17',
  width: '17',
  height: '7',
  weight: '8'
};

/**
 * More flexible US multi-line address parser.
 *
 * Heuristics:
 *  - Last line is assumed to be "City, ST ZIP" or "City ST ZIP".
 *  - Among the remaining lines, the first line that "looks like a street"
 *    (contains a common street keyword, optionally with digits) is treated as street1.
 *  - Lines before street1:
 *      - If street1 is at index 0 → no explicit name/company.
 *      - If street1 is at index 1 → [0] is name, no company.
 *      - If street1 is at index >= 2 → [0] is name, [1] is company.
 *  - Lines between street1 and city/state/zip are joined into street2
 *    (e.g., "Bsmt", "Apt 3B", "Suite 500").
 *
 * This version avoids treating any line with a digit as a street; it requires
 * a street keyword (St, Ave, Blvd, Rd, etc.), so company names like "127 Labs Inc"
 * are not misclassified as street lines.
 */
function parseAddressMultiline(raw) {
  const empty = {
    name: '',
    company: '',
    street1: '',
    street2: '',
    city: '',
    state: '',
    zip: ''
  };

  if (!raw || typeof raw !== 'string') {
    return empty;
  }

  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return empty;
  }

  // --- Parse city/state/zip from the last line ---
  const cityStateZipLine = lines[lines.length - 1];
  let city = '';
  let state = '';
  let zip = '';

  // Try "City, ST ZIP"
  const commaIdx = cityStateZipLine.indexOf(',');
  if (commaIdx !== -1) {
    city = cityStateZipLine.slice(0, commaIdx).trim();
    const stateZipPart = cityStateZipLine.slice(commaIdx + 1).trim();
    const parts = stateZipPart.split(/\s+/);
    if (parts.length >= 2) {
      state = parts[0];
      zip = parts[parts.length - 1];
    } else if (parts.length === 1) {
      state = parts[0];
    }
  } else {
    // Fallback: maybe "City ST ZIP" or similar
    const parts = cityStateZipLine.split(/\s+/);
    if (parts.length >= 3) {
      city = parts.slice(0, parts.length - 2).join(' ');
      state = parts[parts.length - 2];
      zip = parts[parts.length - 1];
    }
  }

  // Everything before the last line is "head" (name/company/street)
  const head = lines.slice(0, lines.length - 1);
  if (head.length === 0) {
    return {
      ...empty,
      city: city || '',
      state: state || '',
      zip: zip || ''
    };
  }

  // Heuristic for "looks like a street" (typical street words, maybe digits)
  const streetKeywords = [
    ' st', ' street',
    ' ave', ' avenue',
    ' blvd', ' boulevard',
    ' rd', ' road',
    ' dr', ' drive',
    ' ln', ' lane',
    ' ter', ' terrace',
    ' way',
    ' hwy', ' highway',
    ' pkwy', ' parkway',
    ' ct', ' court',
    ' cir', ' circle',
    ' pl', ' place'
  ];

  function looksLikeStreet(line) {
    const lower = line.toLowerCase();
    const hasDigit = /\d/.test(line);
    const hasStreetKeyword = streetKeywords.some((kw) => lower.includes(kw));

    // Primary rule: must have a street keyword.
    // - If it also has a digit → classic "123 Main St" style.
    // - If no digit, but has street word → still acceptable (e.g., "Main Street").
    if (hasStreetKeyword) return true;

    // No street keyword → do NOT treat as street.
    // This prevents "127 Labs Inc" from being misclassified.
    return false;
  }

  let streetIndex = head.findIndex(looksLikeStreet);
  if (streetIndex === -1) {
    // No obvious street; assume last head line is street
    streetIndex = head.length - 1;
  }

  // Decide name & company based on where the street starts
  let name = '';
  let company = '';

  if (streetIndex === 0) {
    // No explicit name/company; only street-ish stuff
    name = '';
    company = '';
  } else if (streetIndex === 1) {
    // [0] is name, no company
    name = head[0];
    company = '';
  } else {
    // [0] is name, [1] is company
    name = head[0];
    company = head[1];
  }

  const street1 = head[streetIndex] || '';
  const extraStreetLines = head.slice(streetIndex + 1);
  const street2 = extraStreetLines.length > 0 ? extraStreetLines.join(', ') : '';

  return {
    name: name || '',
    company: company || '',
    street1: street1 || '',
    street2: street2 || '',
    city: city || '',
    state: state || '',
    zip: zip || ''
  };
}

/**
 * Create a Shippo shipment and return available rates (no purchase).
 * Returns { shipment, rates } where rates is an array as returned by Shippo.
 */
async function createShipmentAndGetRates(shipmentBody, logger) {
  const log = logger || console;
  const headers = {
    Authorization: `ShippoToken ${SHIPPO_API_TOKEN}`,
    'Content-Type': 'application/json'
  };

  let shipment;
  try {
    const res = await fetch('https://api.goshippo.com/shipments/', {
      method: 'POST',
      headers,
      body: JSON.stringify(shipmentBody)
    });
    const txt = await res.text();
    if (!res.ok) {
      throw new Error(`Shippo /shipments failed ${res.status}: ${txt}`);
    }
    shipment = JSON.parse(txt);
  } catch (e) {
    log.error?.('Shippo error while creating shipment for rates:', e?.stack || e?.message || e);
    throw e;
  }

  const rates = Array.isArray(shipment?.rates) ? shipment.rates : [];
  return { shipment, rates };
}

/**
 * Purchase a label for a specific rate object_id.
 * Returns { trackingNumber, labelUrl, trackingUrl }.
 */
async function buyLabelForRate(rateObjectId, logger) {
  const log = logger || console;
  const headers = {
    Authorization: `ShippoToken ${SHIPPO_API_TOKEN}`,
    'Content-Type': 'application/json'
  };
  const txBody = {
    rate: rateObjectId,
    label_file_type: 'PDF_4x6',
    async: false
  };

  let transaction;
  try {
    const res = await fetch('https://api.goshippo.com/transactions/', {
      method: 'POST',
      headers,
      body: JSON.stringify(txBody)
    });
    const txt = await res.text();
    if (!res.ok) {
      throw new Error(`Shippo /transactions failed ${res.status}: ${txt}`);
    }
    transaction = JSON.parse(txt);
  } catch (e) {
    log.error?.('Shippo error while buying label for selected rate:', e?.stack || e?.message || e);
    throw e;
  }

  if (transaction.status !== 'SUCCESS') {
    const messages = transaction.messages ? JSON.stringify(transaction.messages) : '';
    throw new Error(`Shippo transaction not successful. Status: ${transaction.status}. Messages: ${messages}`);
  }

  return {
    trackingNumber: transaction.tracking_number || null,
    labelUrl: transaction.label_url || transaction.label_file || null,
    trackingUrl: transaction.tracking_url_provider || null
  };
}

/**
 * Create a return label via Shippo using the provided shipment data.
 * Returns { trackingNumber, labelUrl, trackingUrl, carrierName, serviceName, etaDays } on success.
 *
 * Uses Shippo's "create shipment -> buy label" flow:
 *  1) POST /shipments
 *  2) Take first rate
 *  3) POST /transactions
 */
async function createReturnLabelWithShippo(shipmentBody, logger) {
  const log = logger || console;

  const headers = {
    Authorization: `ShippoToken ${SHIPPO_API_TOKEN}`,
    'Content-Type': 'application/json'
  };

  // 1) Create a Shipment with the provided data
  let shipment;
  try {
    const shipmentRes = await fetch('https://api.goshippo.com/shipments/', {
      method: 'POST',
      headers,
      body: JSON.stringify(shipmentBody)
    });

    const shipmentText = await shipmentRes.text();
    if (!shipmentRes.ok) {
      throw new Error(`Shippo /shipments failed ${shipmentRes.status}: ${shipmentText}`);
    }

    shipment = JSON.parse(shipmentText);
  } catch (e) {
    log.error?.('Shippo error while creating shipment:', e?.stack || e?.message || e);
    throw e;
  }

  const rates = shipment?.rates;
  if (!Array.isArray(rates) || rates.length === 0) {
    throw new Error('Shippo returned no rates for shipment.');
  }

  const chosenRate = rates[0];

  // 2) Buy a label (transaction) for that rate
  const transactionBody = {
    rate: chosenRate.object_id,
    label_file_type: 'PDF_4x6',
    async: false
  };

  let transaction;
  try {
    const txRes = await fetch('https://api.goshippo.com/transactions/', {
      method: 'POST',
      headers,
      body: JSON.stringify(transactionBody)
    });

    const txText = await txRes.text();
    if (!txRes.ok) {
      throw new Error(`Shippo /transactions failed ${txRes.status}: ${txText}`);
    }

    transaction = JSON.parse(txText);
  } catch (e) {
    log.error?.('Shippo error while creating transaction:', e?.stack || e?.message || e);
    throw e;
  }

  if (transaction.status !== 'SUCCESS') {
    // Shippo may still return a JSON with messages if something went wrong
    const messages = transaction.messages ? JSON.stringify(transaction.messages) : '';
    throw new Error(`Shippo transaction not successful. Status: ${transaction.status}. Messages: ${messages}`);
  }

  const trackingNumber = transaction.tracking_number || null;
  const labelUrl = transaction.label_url || transaction.label_file || null;
  const trackingUrl = transaction.tracking_url_provider || null;

  const carrierName =
    chosenRate.provider ||
    chosenRate.carrier ||
    (chosenRate.carrier_account && chosenRate.carrier_account.carrier) ||
    'Unknown carrier';

  const serviceName =
    (chosenRate.servicelevel && chosenRate.servicelevel.name) ||
    chosenRate.servicelevel_name ||
    chosenRate.service ||
    'Unknown service';

  const etaDays =
    typeof chosenRate.estimated_days === 'number'
      ? chosenRate.estimated_days
      : null;

  if (!labelUrl) {
    throw new Error('Shippo transaction succeeded but label URL is missing.');
  }

  return {
    trackingNumber,
    labelUrl,
    trackingUrl,
    carrierName,
    serviceName,
    etaDays
  };
}

/* =========================
   Slack App (Socket Mode)
========================= */

const slackApp = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  socketMode: true,
  processBeforeResponse: true
});

slackApp.error((e) => {
  console.error('⚠️ Bolt error:', e?.stack || e?.message || e);
});

/* =========================
   Slash Commands Baseline
========================= */

/**
 * /shippinglabel baseline handler
 * For now:
 *  - Acks promptly
 *  - Logs command usage into ./data/commands-log.json
 *  - Posts a confirmation message into WATCH_CHANNEL_ID (if set) or the invoking channel
 */
slackApp.command('/shippinglabel', async ({ ack, body, client, logger }) => {
  await ack();

  const nowIso = new Date().toISOString();
  const targetChannel = WATCH_CHANNEL_ID || body.channel_id;

  const entry = {
    type: 'shippinglabel',
    userId: body.user_id,
    userName: body.user_name,
    channelId: body.channel_id,
    teamId: body.team_id,
    text: (body.text || '').trim(),
    ts: nowIso
  };

  try {
    await appendCommandLog(entry);
  } catch (e) {
    logger?.warn?.('Failed to log /shippinglabel command:', e);
  }

  try {
    await client.chat.postMessage({
      channel: targetChannel,
      text: '🚚 Received `/shippinglabel`. Baseline bot is running; shipping label flow will be implemented next.'
    });
  } catch (e) {
    console.error('Failed to post /shippinglabel response:', e?.stack || e?.message || e);
  }
});

/**
 * /returnlabel handler
 * Now:
 *  - Acks promptly
 *  - Logs command usage into ./data/commands-log.json
 *  - Opens an "Edit Details" modal with address + package + shipping service mode
 */
slackApp.command('/returnlabel', async ({ ack, body, client, logger }) => {
  await ack();

  const nowIso = new Date().toISOString();
  const targetChannel = WATCH_CHANNEL_ID || body.channel_id;

  const entry = {
    type: 'returnlabel',
    userId: body.user_id,
    userName: body.user_name,
    channelId: body.channel_id,
    teamId: body.team_id,
    text: (body.text || '').trim(),
    ts: nowIso
  };

  try {
    await appendCommandLog(entry);
  } catch (e) {
    logger?.warn?.('Failed to log /returnlabel command:', e);
  }

const privateMetadata = JSON.stringify({
  channelId: targetChannel,
  userChannelId: body.channel_id,
  userId: body.user_id
});

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'returnlabel_edit_modal',
        private_metadata: privateMetadata,
        title: {
          type: 'plain_text',
          text: 'Return Label – Edit',
          emoji: true
        },
        submit: {
          type: 'plain_text',
          text: 'Next',
          emoji: true
        },
        close: {
          type: 'plain_text',
          text: 'Cancel',
          emoji: true
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Configure the return label details, then click *Next*.'
            }
          },
          { type: 'divider' },

          /* Ship From Mode */
          {
            type: 'section',
            block_id: 'from_address_mode_block',
            text: { type: 'mrkdwn', text: '*Ship From address*' },
            accessory: {
              type: 'radio_buttons',
              action_id: 'from_address_mode',
              initial_option: {
                text: { type: 'plain_text', text: 'Use default Carismo address', emoji: true },
                value: 'default'
              },
              options: [
                {
                  text: { type: 'plain_text', text: 'Use default Carismo address', emoji: true },
                  value: 'default'
                },
                {
                  text: { type: 'plain_text', text: 'Enter a custom address', emoji: true },
                  value: 'custom'
                }
              ]
            }
          },
          {
  type: 'input',
  block_id: 'from_address_multiline_block',
  label: { type: 'plain_text', text: 'Ship From (multi-line address)', emoji: true },
  element: {
    type: 'plain_text_input',
    action_id: 'from_address_multiline',
    multiline: true,
    initial_value: ''
  },
  hint: { type: 'plain_text', text: 'Lines: Name, Company (optional), Street, City, ST ZIP' },
  optional: true
},

          /* Ship To (fixed) */
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Ship To (fixed):*\n```' + DEFAULT_TO_ADDRESS_TEXT + '```'
            }
          },
          { type: 'divider' },

          /* Package Mode */
          {
            type: 'section',
            block_id: 'parcel_mode_block',
            text: { type: 'mrkdwn', text: '*Package info*' },
            accessory: {
              type: 'radio_buttons',
              action_id: 'parcel_mode',
              initial_option: {
                text: { type: 'plain_text', text: 'Use default package (17" x 17" x 7", 8 lb)', emoji: true },
                value: 'default'
              },
              options: [
                {
                  text: { type: 'plain_text', text: 'Use default package (17" x 17" x 7", 8 lb)', emoji: true },
                  value: 'default'
                },
                {
                  text: { type: 'plain_text', text: 'Enter custom package info', emoji: true },
                  value: 'custom'
                }
              ]
            }
          },
          {
  type: 'input',
  block_id: 'parcel_length_block',
  label: { type: 'plain_text', text: 'Parcel Length (in)', emoji: true },
  element: { type: 'plain_text_input', action_id: 'parcel_length', initial_value: '' },
  optional: true
},
{
  type: 'input',
  block_id: 'parcel_width_block',
  label: { type: 'plain_text', text: 'Parcel Width (in)', emoji: true },
  element: { type: 'plain_text_input', action_id: 'parcel_width', initial_value: '' },
  optional: true
},
{
  type: 'input',
  block_id: 'parcel_height_block',
  label: { type: 'plain_text', text: 'Parcel Height (in)', emoji: true },
  element: { type: 'plain_text_input', action_id: 'parcel_height', initial_value: '' },
  optional: true
},
{
  type: 'input',
  block_id: 'parcel_weight_block',
  label: { type: 'plain_text', text: 'Parcel Weight (lb)', emoji: true },
  element: { type: 'plain_text_input', action_id: 'parcel_weight', initial_value: '' },
  optional: true
},

          { type: 'divider' },

          /* Shipping Service Mode */
                    {
            type: 'section',
            block_id: 'service_mode_block',
            text: { type: 'mrkdwn', text: '*Shipping service*' },
            accessory: {
              type: 'radio_buttons',
              action_id: 'service_mode',
              initial_option: {
                text: { type: 'plain_text', text: 'Use default (UPS Ground if available)', emoji: true },
                value: 'default'
              },
              options: [
                {
                  text: { type: 'plain_text', text: 'Use default (UPS Ground if available)', emoji: true },
                  value: 'default'
                },
                {
                  text: { type: 'plain_text', text: 'Choose from available services', emoji: true },
                  value: 'choose'
                }
              ]
            }
          },
          {
            type: 'input',
            block_id: 'signature_block',
            label: {
              type: 'plain_text',
              text: 'Signature requirement',
              emoji: true
            },
            element: {
              type: 'checkboxes',
              action_id: 'signature_toggle',
              options: [
                {
                  text: {
                    type: 'plain_text',
                    text: 'Check to NOT require signature (signature required by default)',
                    emoji: true
                  },
                  value: 'no_signature'
                }
              ]
            },
            optional: true
          }
        ]
      }
    });
  } catch (e) {
    console.error('Failed to open /returnlabel edit modal:', e?.stack || e?.message || e);
  }
});

/**
 * View submission handler for the "Edit Details" modal.
 * Builds a shipment object. If service_mode=choose, posts rate options with buttons.
 * If service_mode=default, tries UPS Ground; if missing, posts rate options.
 * Review modal is opened either immediately (UPS Ground chosen) or after button pick.
 */
slackApp.view('returnlabel_edit_modal', async ({ ack, body, view, client, logger }) => {
  const log = logger || console;

  // Recover metadata (channelId, userChannelId, userId)
  let channelId = null;
  let userChannelId = null;
  let userIdFromMeta = null;
  try {
    const meta = view.private_metadata ? JSON.parse(view.private_metadata) : {};
    channelId = meta.channelId || null;
    userChannelId = meta.userChannelId || null;
    userIdFromMeta = meta.userId || null;
  } catch (e) {
    log.error?.('Failed to parse private_metadata in edit modal:', e?.stack || e?.message || e);
  }

  const ephemeralChannelId = userChannelId || channelId || body.channel?.id || body.team?.id || undefined;
  const ephemeralUserId = userIdFromMeta || body.user?.id;

  const values = view.state.values;
  const getVal = (b, a) => values[b]?.[a]?.value || '';

// Ship From mode and raw input
const fromMode = values['from_address_mode_block']?.['from_address_mode']?.selected_option?.value || 'default';
const fromAddressInputRaw = getVal('from_address_multiline_block', 'from_address_multiline') || '';
const fromAddressTrimmed = fromAddressInputRaw.trim();

// If user typed anything, treat it as "custom" regardless of radio selection
const fromModeResolved = fromAddressTrimmed.length > 0 ? 'custom' : fromMode;

// Backend default is still Carismo unless they typed something
const fromRawText =
  fromModeResolved === 'default'
    ? DEFAULT_FROM_ADDRESS_TEXT
    : (fromAddressTrimmed || DEFAULT_FROM_ADDRESS_TEXT);

  // Ship To fixed
  const toRawText = DEFAULT_TO_ADDRESS_TEXT;

  // Parse addresses
  const parsedFrom = parseAddressMultiline(fromRawText);
  const parsedTo = parseAddressMultiline(toRawText);

 // Package mode & values
const parcelMode = values['parcel_mode_block']?.['parcel_mode']?.selected_option?.value || 'default';
const parcelLengthRaw = getVal('parcel_length_block', 'parcel_length').trim();
const parcelWidthRaw  = getVal('parcel_width_block',  'parcel_width').trim();
const parcelHeightRaw = getVal('parcel_height_block', 'parcel_height').trim();
const parcelWeightRaw = getVal('parcel_weight_block', 'parcel_weight').trim();

// If any custom fields have content, treat as "custom" regardless of radio selection
const hasAnyParcelInput =
  parcelLengthRaw.length > 0 ||
  parcelWidthRaw.length > 0 ||
  parcelHeightRaw.length > 0 ||
  parcelWeightRaw.length > 0;

const parcelModeResolved = hasAnyParcelInput ? 'custom' : parcelMode;

if (parcelModeResolved === 'custom') {
  const errors = {};
  if (!parcelLengthRaw) errors['parcel_length_block'] = 'Required when using custom package info.';
  if (!parcelWidthRaw)  errors['parcel_width_block']  = 'Required when using custom package info.';
  if (!parcelHeightRaw) errors['parcel_height_block'] = 'Required when using custom package info.';
  if (!parcelWeightRaw) errors['parcel_weight_block'] = 'Required when using custom package info.';
  if (Object.keys(errors).length > 0) {
    await ack({ response_action: 'errors', errors });
    return;
  }
}

const parcelLength = parcelModeResolved === 'default' ? DEFAULT_PARCEL.length : (parcelLengthRaw || DEFAULT_PARCEL.length);
const parcelWidth  = parcelModeResolved === 'default' ? DEFAULT_PARCEL.width  : (parcelWidthRaw  || DEFAULT_PARCEL.width);
const parcelHeight = parcelModeResolved === 'default' ? DEFAULT_PARCEL.height : (parcelHeightRaw || DEFAULT_PARCEL.height);
const parcelWeight = parcelModeResolved === 'default' ? DEFAULT_PARCEL.weight : (parcelWeightRaw || DEFAULT_PARCEL.weight);

// Signature requirement:
// - Default: require STANDARD signature
// - If checkbox is checked → do NOT require signature (omit signature_confirmation)
const signatureSelection =
  values['signature_block']?.['signature_toggle']?.selected_options || [];
const requireSignature = !Array.isArray(signatureSelection) || signatureSelection.length === 0;

  // Build shipment used for rating and (later) purchase
    const shipment = {
    address_from: {
      name: parsedFrom.name || 'Carismo Design',
      company: parsedFrom.company || '',
      street1: parsedFrom.street1 || '71 Winant Place (Suite B)',
      street2: parsedFrom.street2 || '',
      city: parsedFrom.city || 'Staten Island',
      state: parsedFrom.state || 'NY',
      zip: parsedFrom.zip || '10309',
      country: 'US',
      phone: '+1 555 555 5555',
      email: 'test-sender@example.com'
    },
    address_to: {
      name: parsedTo.name || 'Returns Department',
      company: parsedTo.company || 'Carismo Design',
      street1: parsedTo.street1 || '71 Winant Place (Suite B)',
      street2: parsedTo.street2 || '',
      city: parsedTo.city || 'Staten Island',
      state: parsedTo.state || 'NY',
      zip: parsedTo.zip || '10309',
      country: 'US',
      phone: '+1 555 111 2222',
      email: 'test-recipient@example.com'
    },
    parcels: [
      {
        length: parcelLength,
        width: parcelWidth,
        height: parcelHeight,
        distance_unit: 'in',
        weight: parcelWeight,
        mass_unit: 'lb'
      }
    ],
    async: false
  };

  // Attach signature requirement to shipment.extra if needed
  if (requireSignature) {
    shipment.extra = {
      signature_confirmation: 'STANDARD'
    };
  }

  // Service mode
  const serviceMode = values['service_mode_block']?.['service_mode']?.selected_option?.value || 'default';

  // Helper to format rates into blocks (list + buttons)
  function buildRateBlocks(ratesArr) {
    const lines = ratesArr.map((r, idx) => {
      const provider = r.provider || r.carrier || (r.carrier_account && r.carrier_account.carrier) || 'Unknown';
      const service  = (r.servicelevel && r.servicelevel.name) || r.servicelevel_name || r.service || 'Unknown';
      const amountNum = r.amount ? Number(r.amount) : null;
      const price = amountNum != null && !Number.isNaN(amountNum)
        ? (r.currency === 'USD' ? `$${amountNum.toFixed(2)}` : `${amountNum.toFixed(2)} ${r.currency || ''}`.trim())
        : 'N/A';
      const eta = typeof r.estimated_days === 'number'
        ? `${r.estimated_days} business day${r.estimated_days === 1 ? '' : 's'}`
        : 'ETA N/A';
      return `${idx + 1}. *${provider}* — ${service} — ${price} — ${eta}`;
    });

    const actionBlocks = [];

    // ONE button per actions block to avoid duplicate action_id errors
    for (const r of ratesArr) {
      const provider = r.provider || r.carrier || (r.carrier_account && r.carrier_account.carrier) || 'Unknown';
      const service  = (r.servicelevel && r.servicelevel.name) || r.servicelevel_name || r.service || 'Unknown';
      const valuePayload = {
        channelId,
        shipment,
        selectedRate: {
          id: r.object_id,
          provider,
          service,
          amount: r.amount || null,
          currency: r.currency || 'USD',
          etaDays: typeof r.estimated_days === 'number' ? r.estimated_days : null
        }
      };

      actionBlocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'service_option_select',
            text: { type: 'plain_text', text: `${provider} – ${service}`, emoji: true },
            value: JSON.stringify(valuePayload)
          }
        ]
      });
    }

    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Select a shipping service for this return label:*' }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: lines.join('\n') || '_No services available._' }
      },
      ...actionBlocks
    ];
  }

  // Get rates once (used by both branches)
let rates;
try {
  const rated = await createShipmentAndGetRates(shipment, logger);
  rates = rated.rates || [];
} catch (e) {
  await ack(); // close modal
  try {
    await client.chat.postEphemeral({
      channel: ephemeralChannelId,
      user: ephemeralUserId,
      text: `❌ Failed to fetch shipping services from Shippo: \`${e?.message || e}\``
    });
  } catch {}
  return;
}

if (!Array.isArray(rates) || rates.length === 0) {
  await ack(); // close modal
  try {
    await client.chat.postEphemeral({
      channel: ephemeralChannelId,
      user: ephemeralUserId,
      text: `❌ No shipping services returned for this shipment. Please verify addresses and package dimensions.`
    });
  } catch {}
  return;
}

// If user wants to choose, present the options and stop here.
if (serviceMode === 'choose') {
  await ack(); // close modal
  try {
    await client.chat.postEphemeral({
      channel: ephemeralChannelId,
      user: ephemeralUserId,
      blocks: buildRateBlocks(rates),
      text: 'Select a shipping service' // fallback
    });
  } catch (e) {
    try {
      await client.chat.postEphemeral({
        channel: ephemeralChannelId,
        user: ephemeralUserId,
        text: `❌ Failed to post shipping options: \`${e?.message || e}\``
      });
    } catch {}
  }
  return;
}

  // Default mode: try UPS Ground (but NOT UPS Ground Saver) first; if missing, fall back to choose flow.
  const upsGround = rates.find((r) => {
    const provider = (r.provider || r.carrier || (r.carrier_account && r.carrier_account.carrier) || '').toLowerCase();
    const service  = ((r.servicelevel && r.servicelevel.name) || r.servicelevel_name || r.service || '').toLowerCase();

    // Require UPS + "ground" in the service name, but explicitly exclude any "saver" variants.
    return provider === 'ups' && service.includes('ground') && !service.includes('saver');
  });

  if (!upsGround) {
  await ack(); // close modal
  try {
    await client.chat.postEphemeral({
      channel: ephemeralChannelId,
      user: ephemeralUserId,
      text: 'UPS Ground not available for this shipment. Please choose a service from the options below.',
      blocks: buildRateBlocks(rates)
    });
  } catch (e) {
    try {
      await client.chat.postEphemeral({
        channel: ephemeralChannelId,
        user: ephemeralUserId,
        text: `❌ Failed to post shipping options: \`${e?.message || e}\``
      });
    } catch {}
  }
  return;
}

  // Build review with the preselected UPS Ground
  const selectedRate = {
    id: upsGround.object_id,
    provider: upsGround.provider || upsGround.carrier || (upsGround.carrier_account && upsGround.carrier_account.carrier) || 'UPS',
    service: (upsGround.servicelevel && upsGround.servicelevel.name) || upsGround.servicelevel_name || upsGround.service || 'Ground',
    amount: upsGround.amount || null,
    currency: upsGround.currency || 'USD',
    etaDays: typeof upsGround.estimated_days === 'number' ? upsGround.estimated_days : null
  };

  const priceStr = selectedRate.amount
    ? (selectedRate.currency === 'USD' ? `$${Number(selectedRate.amount).toFixed(2)}` : `${Number(selectedRate.amount).toFixed(2)} ${selectedRate.currency}`)
    : 'N/A';
  const etaStr = selectedRate.etaDays != null ? `${selectedRate.etaDays} business day${selectedRate.etaDays === 1 ? '' : 's'}` : 'N/A';

  const reviewMetadata = JSON.stringify({
    channelId,
    shipment,
    selectedRate
  });

  const reviewTextLines = [
  '*Ship From (parsed):*',
  `Name: ${shipment.address_from.name || 'N/A'}`,
  `Company: ${shipment.address_from.company || 'N/A'}`,
  `Street: ${shipment.address_from.street1 || 'N/A'}`,
  `Street 2: ${shipment.address_from.street2 || 'N/A'}`,
  `City: ${shipment.address_from.city || 'N/A'}`,
  `State: ${shipment.address_from.state || 'N/A'}`,
  `ZIP: ${shipment.address_from.zip || 'N/A'}`,
  '',
  '*Ship To (parsed):*',
  `Name: ${shipment.address_to.name || 'N/A'}`,
  `Company: ${shipment.address_to.company || 'N/A'}`,
  `Street: ${shipment.address_to.street1 || 'N/A'}`,
  `Street 2: ${shipment.address_to.street2 || 'N/A'}`,
  `City: ${shipment.address_to.city || 'N/A'}`,
  `State: ${shipment.address_to.state || 'N/A'}`,
  `ZIP: ${shipment.address_to.zip || 'N/A'}`,
  '',
  '*Parcel:*',
  `${parcelLength}" x ${parcelWidth}" x ${parcelHeight}" (${parcelWeight} lb)`,
  '',
  '*Shipping Service:*',
  `${selectedRate.provider} — ${selectedRate.service} — ${priceStr} — ETA: ${etaStr}`
];

  // Update to review modal with selected UPS Ground
  await ack({
    response_action: 'update',
    view: {
      type: 'modal',
      callback_id: 'returnlabel_review_modal',
      private_metadata: reviewMetadata,
      title: { type: 'plain_text', text: 'Return Label – Review', emoji: true },
      submit: { type: 'plain_text', text: 'Create Label', emoji: true },
      close:  { type: 'plain_text', text: 'Back', emoji: true },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: 'Please review the details below.' } },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: reviewTextLines.join('\n') } }
      ]
    }
  });
});

/**
 * Button handler: user picks a specific shipping service option.
 * Opens the Review modal with the chosen rate.
 */
slackApp.action('service_option_select', async ({ ack, body, client, logger }) => {
  await ack();

  const log = logger || console;
  const action = body?.actions?.[0];
  let payload;
  try {
    payload = action?.value ? JSON.parse(action.value) : null;
  } catch (e) {
    payload = null;
  }

  if (!payload || !payload.channelId || !payload.shipment || !payload.selectedRate) {
    log.error?.('Malformed service selection payload.', payload);
    return;
  }

  const { channelId, shipment, selectedRate } = payload;

  const priceStr = selectedRate.amount
    ? (selectedRate.currency === 'USD' ? `$${Number(selectedRate.amount).toFixed(2)}` : `${Number(selectedRate.amount).toFixed(2)} ${selectedRate.currency}`)
    : 'N/A';
  const etaStr = selectedRate.etaDays != null ? `${selectedRate.etaDays} business day${selectedRate.etaDays === 1 ? '' : 's'}` : 'N/A';

  const reviewMetadata = JSON.stringify({
    channelId,
    shipment,
    selectedRate
  });

    const reviewTextLines = [
    '*Ship From (parsed):*',
    `Name: ${shipment.address_from.name || 'N/A'}`,
    `Company: ${shipment.address_from.company || 'N/A'}`,
    `Street: ${shipment.address_from.street1 || 'N/A'}`,
    `Street 2: ${shipment.address_from.street2 || 'N/A'}`,
    `City: ${shipment.address_from.city || 'N/A'}`,
    `State: ${shipment.address_from.state || 'N/A'}`,
    `ZIP: ${shipment.address_from.zip || 'N/A'}`,
    '',
    '*Ship To (parsed):*',
    `Name: ${shipment.address_to.name || 'N/A'}`,
    `Company: ${shipment.address_to.company || 'N/A'}`,
    `Street: ${shipment.address_to.street1 || 'N/A'}`,
    `Street 2: ${shipment.address_to.street2 || 'N/A'}`,
    `City: ${shipment.address_to.city || 'N/A'}`,
    `State: ${shipment.address_to.state || 'N/A'}`,
    `ZIP: ${shipment.address_to.zip || 'N/A'}`,
    '',
    '*Parcel:*',
    `${shipment.parcels[0].length}" x ${shipment.parcels[0].width}" x ${shipment.parcels[0].height}" (${shipment.parcels[0].weight} lb)`,
    '',
    '*Shipping Service:*',
    `${selectedRate.provider} — ${selectedRate.service} — ${priceStr} — ETA: ${etaStr}`
  ];

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'returnlabel_review_modal',
        private_metadata: reviewMetadata,
        title: { type: 'plain_text', text: 'Return Label – Review', emoji: true },
        submit: { type: 'plain_text', text: 'Create Label', emoji: true },
        close:  { type: 'plain_text', text: 'Cancel', emoji: true },
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: 'Please review the details below.' } },
          { type: 'divider' },
          { type: 'section', text: { type: 'mrkdwn', text: reviewTextLines.join('\n') } }
        ]
      }
    });
  } catch (e) {
    log.error?.('Failed to open review modal after service select:', e?.stack || e?.message || e);
    try {
      await client.chat.postMessage({
        channel: channelId,
        text: `❌ Failed to open Review modal: \`${e?.message || e}\``
      });
    } catch {}
  }
});

/**
 * View submission handler for the "Review" modal.
 * If a selectedRate is present, buys that exact rate; else uses fallback createReturnLabelWithShippo.
 * Then downloads the PDF and uploads it to Slack with carrier/service/ETA.
 */
slackApp.view('returnlabel_review_modal', async ({ ack, body, view, client, logger }) => {
  // Close/submit the modal
  await ack();

  const log = logger || console;

  let channelId = null;
  let shipment = null;
  let selectedRate = null;

  try {
    const meta = view.private_metadata ? JSON.parse(view.private_metadata) : {};
    channelId = meta.channelId || null;
    shipment = meta.shipment || null;
    selectedRate = meta.selectedRate || null;
  } catch (e) {
    log.error?.('Failed to parse private_metadata in review modal:', e?.stack || e?.message || e);
  }

  if (!channelId || !shipment) {
    log.error?.('Missing channelId or shipment data in review modal.');
    return;
  }

  // 1) Buy label (selected rate if provided; else default flow)
  let trackingNumber, labelUrl, trackingUrl;
  let carrierOut = null, serviceOut = null, etaDaysOut = null;

  try {
    if (selectedRate?.id) {
      const tx = await buyLabelForRate(selectedRate.id, logger);
      trackingNumber = tx.trackingNumber;
      labelUrl = tx.labelUrl;
      trackingUrl = tx.trackingUrl;
      carrierOut = selectedRate.provider || null;
      serviceOut = selectedRate.service || null;
      etaDaysOut = typeof selectedRate.etaDays === 'number' ? selectedRate.etaDays : null;
    } else {
      const label = await createReturnLabelWithShippo(shipment, logger);
      trackingNumber = label.trackingNumber;
      labelUrl = label.labelUrl;
      trackingUrl = label.trackingUrl;
      carrierOut = label.carrierName || null;
      serviceOut = label.serviceName || null;
      etaDaysOut = typeof label.etaDays === 'number' ? label.etaDays : null;
    }
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('Failed to create Shippo return label:', e?.stack || msg);
    try {
      await client.chat.postMessage({
        channel: channelId,
        text: `❌ Failed to create Shippo return label: \`${msg}\``
      });
    } catch {}
    return;
  }

  const etaDescription =
    typeof etaDaysOut === 'number'
      ? `${etaDaysOut} business day${etaDaysOut === 1 ? '' : 's'} (estimated)`
      : 'N/A';

  // 2) Download the PDF from Shippo
  let pdfBuffer;
  try {
    const pdfRes = await fetch(labelUrl);
    if (!pdfRes.ok) {
      const txt = await pdfRes.text();
      throw new Error(`Download failed ${pdfRes.status}: ${txt}`);
    }
    const pdfArrayBuf = await pdfRes.arrayBuffer();
    pdfBuffer = Buffer.from(pdfArrayBuf);
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('Failed to download Shippo label PDF:', e?.stack || msg);
    try {
      await client.chat.postMessage({
        channel: channelId,
        text:
          `✅ Created Shippo return label, but failed to download the PDF.\n` +
          `*Tracking number:* ${trackingNumber || 'N/A'}\n` +
          `*Carrier:* ${carrierOut || 'N/A'}\n` +
          `*Service:* ${serviceOut || 'N/A'}\n` +
          `*ETA:* ${etaDescription}\n` +
          `Tracking URL: ${trackingUrl || 'N/A'}\n` +
          `Error downloading PDF: \`${msg}\``
      });
    } catch {}
    return;
  }

  // 3) Upload the PDF into Slack
  try {
    await client.files.uploadV2({
      channel_id: channelId,
      filename: 'return-label.pdf',
      file: pdfBuffer,
      initial_comment:
        `📦 *Return label created*\n` +
        `• *Tracking number:* ${trackingNumber || 'N/A'}\n` +
        `• *Carrier:* ${carrierOut || 'N/A'}\n` +
        `• *Service:* ${serviceOut || 'N/A'}\n` +
        `• *ETA:* ${etaDescription}`
    });
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('Failed to upload label PDF to Slack:', e?.stack || msg);
    try {
      await client.chat.postMessage({
        channel: channelId,
        text:
          `✅ Created Shippo return label, but failed to upload the PDF to Slack.\n` +
          `*Tracking number:* ${trackingNumber || 'N/A'}\n` +
          `*Carrier:* ${carrierOut || 'N/A'}\n` +
          `*Service:* ${serviceOut || 'N/A'}\n` +
          `*ETA:* ${etaDescription}\n` +
          `Tracking URL: ${trackingUrl || 'N/A'}\n` +
          `Upload error: \`${msg}\``
      });
    } catch {}
  }
});

/* =========================
   Express HTTP server
   (healthcheck + future webhooks)
========================= */

const webApp = express();
webApp.use(express.json());

// Simple healthcheck for uptime monitoring / Kubernetes / etc.
webApp.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    app: 'shipping-label-maker-bot',
    status: 'healthy',
    time: new Date().toISOString()
  });
});

// Catch-all 404 for any other paths (so non-matching routes don't hang)
webApp.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Not Found'
  });
});

/* =========================
   Start
========================= */

(async () => {
  try {
    await ensureDataDir();
  } catch (e) {
    console.error('⚠️ Failed to ensure data directory:', e?.stack || e?.message || e);
    // We do not exit; the bot can still run but persistence will be degraded.
  }

  // Start Express HTTP server only if PORT is explicitly set.
  if (PORT && String(PORT).trim() !== '') {
    const port = Number(PORT);
    if (!Number.isFinite(port) || port <= 0) {
      console.error(`❌ Invalid PORT value "${PORT}". Skipping Express HTTP server start.`);
    } else {
      webApp.listen(port, () => {
        console.log(`🌐 Express server listening on port ${port} (healthcheck at /health)`);
      });
    }
  } else {
    console.log('ℹ️ PORT not set; skipping Express HTTP server.');
  }

  // Start Slack Bolt app (Socket Mode)
  try {
    await slackApp.start();
    console.log('✅ shipping-label-maker-bot running (Socket Mode)');
  } catch (e) {
    console.error('❌ Failed to start Slack Bolt app:', e?.stack || e?.message || e);
    process.exit(1);
  }
})();