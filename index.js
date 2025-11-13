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

/**
 * Create a test return label via Shippo using dummy shipment data.
 * Returns { trackingNumber, labelUrl, trackingUrl } on success.
 *
 * Uses Shippo's "create shipment -> buy label" flow:
 *  1) POST /shipments
 *  2) Take first rate
 *  3) POST /transactions
 */
async function createTestReturnLabelWithShippo(logger) {
  const log = logger || console;

  const headers = {
    Authorization: `ShippoToken ${SHIPPO_API_TOKEN}`,
    'Content-Type': 'application/json'
  };

  // 1) Create a Shipment with dummy data (both addresses in US, 1 small parcel)
  const shipmentBody = {
    address_from: {
      name: 'Carismo Returns (TEST)',
      company: 'Carismo Design',
      street1: '215 Clayton St.',
      city: 'San Francisco',
      state: 'CA',
      zip: '94117',
      country: 'US',
      phone: '+1 555 555 5555',
      email: 'test-sender@example.com'
    },
    address_to: {
      name: 'Test Customer',
      street1: '965 Mission St',
      city: 'San Francisco',
      state: 'CA',
      zip: '94103',
      country: 'US',
      phone: '+1 555 111 2222',
      email: 'test-recipient@example.com'
    },
    parcels: [
      {
        length: '10',
        width: '8',
        height: '4',
        distance_unit: 'in',
        weight: '2',
        mass_unit: 'lb'
      }
    ],
    async: false
  };

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
    throw new Error('Shippo returned no rates for test shipment.');
  }

  const chosenRate = rates[0];

  // 2) Buy a label (transaction) for that rate
  const transactionBody = {
    rate: chosenRate.object_id,
    label_file_type: 'PDF',
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

  if (!labelUrl) {
    throw new Error('Shippo transaction succeeded but label URL is missing.');
  }

  return {
    trackingNumber,
    labelUrl,
    trackingUrl
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
 *  - Creates a Shippo test label with dummy data
 *  - Uploads the label PDF + tracking info into Slack
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

  // 1) Create the label via Shippo
  let label;
  try {
    label = await createTestReturnLabelWithShippo(logger);
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('Failed to create Shippo test return label:', e?.stack || msg);
    try {
      await client.chat.postMessage({
        channel: targetChannel,
        text: `❌ Failed to create Shippo test return label: \`${msg}\``
      });
    } catch (postErr) {
      console.error('Additionally failed to post error back to Slack:', postErr?.stack || postErr?.message || postErr);
    }
    return;
  }

  const { trackingNumber, labelUrl, trackingUrl } = label;

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
    // Fall back to at least sending the URL + tracking
    try {
      await client.chat.postMessage({
        channel: targetChannel,
        text:
          `✅ Created Shippo test return label, but failed to download the PDF.\n` +
          `*Tracking number:* ${trackingNumber || 'N/A'}\n` +
          `*Shippo label URL:* ${labelUrl}\n` +
          (trackingUrl ? `*Tracking link:* ${trackingUrl}\n` : '') +
          `Error downloading PDF: \`${msg}\``
      });
    } catch (postErr) {
      console.error('Additionally failed to post PDF-download error back to Slack:', postErr?.stack || postErr?.message || postErr);
    }
    return;
  }

  // 3) Upload the PDF into Slack
  try {
    await client.files.uploadV2({
      channel_id: targetChannel,
      filename: 'return-label-test.pdf',
      file: pdfBuffer,
      initial_comment:
        `📦 *Test return label created via Shippo*\n` +
        `• *Tracking number:* ${trackingNumber || 'N/A'}\n` +
        (trackingUrl ? `• *Tracking link:* ${trackingUrl}\n` : '') +
        `• *Shippo label URL:* ${labelUrl}`
    });
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('Failed to upload label PDF to Slack:', e?.stack || msg);
    // Fallback: send label URL + tracking as plain message
    try {
      await client.chat.postMessage({
        channel: targetChannel,
        text:
          `✅ Created Shippo test return label, but failed to upload the PDF to Slack.\n` +
          `*Tracking number:* ${trackingNumber || 'N/A'}\n` +
          `*Shippo label URL:* ${labelUrl}\n` +
          (trackingUrl ? `*Tracking link:* ${trackingUrl}\n` : '') +
          `Upload error: \`${msg}\``
      });
    } catch (postErr) {
      console.error('Additionally failed to post upload error back to Slack:', postErr?.stack || postErr?.message || postErr);
    }
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