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
 * Create a return label via Shippo using the provided shipment data.
 * Returns { trackingNumber, labelUrl, trackingUrl, serviceName, etaDays } on success.
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

  const serviceName =
    (chosenRate.servicelevel && chosenRate.servicelevel.name) ||
    chosenRate.servicelevel_name ||
    chosenRate.provider ||
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
 *  - Opens an "Edit Details" modal with test defaults
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
    channelId: targetChannel
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
              text: 'Edit the return label details, then click *Next* to review before creating the label.'
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'input',
            block_id: 'from_name_block',
            label: {
              type: 'plain_text',
              text: 'From Name',
              emoji: true
            },
            element: {
              type: 'plain_text_input',
              action_id: 'from_name',
              initial_value: 'Carismo Returns (TEST)'
            }
          },
          {
            type: 'input',
            block_id: 'from_company_block',
            label: {
              type: 'plain_text',
              text: 'From Company',
              emoji: true
            },
            element: {
              type: 'plain_text_input',
              action_id: 'from_company',
              initial_value: 'Carismo Design'
            }
          },
          {
            type: 'input',
            block_id: 'from_street1_block',
            label: {
              type: 'plain_text',
              text: 'From Street',
              emoji: true
            },
            element: {
              type: 'plain_text_input',
              action_id: 'from_street1',
              initial_value: '215 Clayton St.'
            }
          },
          {
            type: 'input',
            block_id: 'from_city_block',
            label: {
              type: 'plain_text',
              text: 'From City',
              emoji: true
            },
            element: {
              type: 'plain_text_input',
              action_id: 'from_city',
              initial_value: 'San Francisco'
            }
          },
          {
            type: 'input',
            block_id: 'from_state_block',
            label: {
              type: 'plain_text',
              text: 'From State (2-letter)',
              emoji: true
            },
            element: {
              type: 'plain_text_input',
              action_id: 'from_state',
              initial_value: 'CA'
            }
          },
          {
            type: 'input',
            block_id: 'from_zip_block',
            label: {
              type: 'plain_text',
              text: 'From ZIP',
              emoji: true
            },
            element: {
              type: 'plain_text_input',
              action_id: 'from_zip',
              initial_value: '94117'
            }
          },
          {
            type: 'input',
            block_id: 'to_name_block',
            label: {
              type: 'plain_text',
              text: 'To Name',
              emoji: true
            },
            element: {
              type: 'plain_text_input',
              action_id: 'to_name',
              initial_value: 'Test Customer'
            }
          },
          {
            type: 'input',
            block_id: 'to_street1_block',
            label: {
              type: 'plain_text',
              text: 'To Street',
              emoji: true
            },
            element: {
              type: 'plain_text_input',
              action_id: 'to_street1',
              initial_value: '965 Mission St'
            }
          },
          {
            type: 'input',
            block_id: 'to_city_block',
            label: {
              type: 'plain_text',
              text: 'To City',
              emoji: true
            },
            element: {
              type: 'plain_text_input',
              action_id: 'to_city',
              initial_value: 'San Francisco'
            }
          },
          {
            type: 'input',
            block_id: 'to_state_block',
            label: {
              type: 'plain_text',
              text: 'To State (2-letter)',
              emoji: true
            },
            element: {
              type: 'plain_text_input',
              action_id: 'to_state',
              initial_value: 'CA'
            }
          },
          {
            type: 'input',
            block_id: 'to_zip_block',
            label: {
              type: 'plain_text',
              text: 'To ZIP',
              emoji: true
            },
            element: {
              type: 'plain_text_input',
              action_id: 'to_zip',
              initial_value: '94103'
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'input',
            block_id: 'parcel_length_block',
            label: {
              type: 'plain_text',
              text: 'Parcel Length (in)',
              emoji: true
            },
            element: {
              type: 'plain_text_input',
              action_id: 'parcel_length',
              initial_value: '10'
            }
          },
          {
            type: 'input',
            block_id: 'parcel_width_block',
            label: {
              type: 'plain_text',
              text: 'Parcel Width (in)',
              emoji: true
            },
            element: {
              type: 'plain_text_input',
              action_id: 'parcel_width',
              initial_value: '8'
            }
          },
          {
            type: 'input',
            block_id: 'parcel_height_block',
            label: {
              type: 'plain_text',
              text: 'Parcel Height (in)',
              emoji: true
            },
            element: {
              type: 'plain_text_input',
              action_id: 'parcel_height',
              initial_value: '4'
            }
          },
          {
            type: 'input',
            block_id: 'parcel_weight_block',
            label: {
              type: 'plain_text',
              text: 'Parcel Weight (lb)',
              emoji: true
            },
            element: {
              type: 'plain_text_input',
              action_id: 'parcel_weight',
              initial_value: '2'
            }
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
 * Builds a shipment object and updates the modal into a "Review" modal.
 */
slackApp.view('returnlabel_edit_modal', async ({ ack, body, view, client, logger }) => {
  const log = logger || console;

  // Recover metadata (channelId)
  let channelId = null;
  try {
    const meta = view.private_metadata ? JSON.parse(view.private_metadata) : {};
    channelId = meta.channelId || null;
  } catch (e) {
    log.error?.('Failed to parse private_metadata in edit modal:', e?.stack || e?.message || e);
  }

  // Extract values from the modal
  const values = view.state.values;

  function getVal(blockId, actionId) {
    return values[blockId]?.[actionId]?.value?.trim() || '';
  }

  const fromName = getVal('from_name_block', 'from_name');
  const fromCompany = getVal('from_company_block', 'from_company');
  const fromStreet1 = getVal('from_street1_block', 'from_street1');
  const fromCity = getVal('from_city_block', 'from_city');
  const fromState = getVal('from_state_block', 'from_state');
  const fromZip = getVal('from_zip_block', 'from_zip');

  const toName = getVal('to_name_block', 'to_name');
  const toStreet1 = getVal('to_street1_block', 'to_street1');
  const toCity = getVal('to_city_block', 'to_city');
  const toState = getVal('to_state_block', 'to_state');
  const toZip = getVal('to_zip_block', 'to_zip');

  const parcelLength = getVal('parcel_length_block', 'parcel_length');
  const parcelWidth = getVal('parcel_width_block', 'parcel_width');
  const parcelHeight = getVal('parcel_height_block', 'parcel_height');
  const parcelWeight = getVal('parcel_weight_block', 'parcel_weight');

  const shipment = {
    address_from: {
      name: fromName || 'Carismo Returns (TEST)',
      company: fromCompany || 'Carismo Design',
      street1: fromStreet1 || '215 Clayton St.',
      city: fromCity || 'San Francisco',
      state: fromState || 'CA',
      zip: fromZip || '94117',
      country: 'US',
      phone: '+1 555 555 5555',
      email: 'test-sender@example.com'
    },
    address_to: {
      name: toName || 'Test Customer',
      street1: toStreet1 || '965 Mission St',
      city: toCity || 'San Francisco',
      state: toState || 'CA',
      zip: toZip || '94103',
      country: 'US',
      phone: '+1 555 111 2222',
      email: 'test-recipient@example.com'
    },
    parcels: [
      {
        length: parcelLength || '10',
        width: parcelWidth || '8',
        height: parcelHeight || '4',
        distance_unit: 'in',
        weight: parcelWeight || '2',
        mass_unit: 'lb'
      }
    ],
    async: false
  };

  const reviewMetadata = JSON.stringify({
    channelId,
    shipment
  });

  const reviewTextLines = [
    '*From:*',
    `${shipment.address_from.name}`,
    `${shipment.address_from.company}`,
    `${shipment.address_from.street1}`,
    `${shipment.address_from.city}, ${shipment.address_from.state} ${shipment.address_from.zip}`,
    '',
    '*To:*',
    `${shipment.address_to.name}`,
    `${shipment.address_to.street1}`,
    `${shipment.address_to.city}, ${shipment.address_to.state} ${shipment.address_to.zip}`,
    '',
    '*Parcel:*',
    `${shipment.parcels[0].length}" x ${shipment.parcels[0].width}" x ${shipment.parcels[0].height}" (${shipment.parcels[0].weight} lb)`
  ];

  // Use ack with response_action=update to turn this into the review modal
  await ack({
    response_action: 'update',
    view: {
      type: 'modal',
      callback_id: 'returnlabel_review_modal',
      private_metadata: reviewMetadata,
      title: {
        type: 'plain_text',
        text: 'Return Label – Review',
        emoji: true
      },
      submit: {
        type: 'plain_text',
        text: 'Create Label',
        emoji: true
      },
      close: {
        type: 'plain_text',
        text: 'Back',
        emoji: true
      },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Please review the details below. Click *Create Label* to generate the return label.'
          }
        },
        {
          type: 'divider'
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: reviewTextLines.join('\n')
          }
        }
      ]
    }
  });
});

/**
 * View submission handler for the "Review" modal.
 * Calls Shippo to create the label, downloads the PDF, and uploads to Slack.
 */
slackApp.view('returnlabel_review_modal', async ({ ack, body, view, client, logger }) => {
  // Close the modal
  await ack();

  const log = logger || console;

  let channelId = null;
  let shipment = null;

  try {
    const meta = view.private_metadata ? JSON.parse(view.private_metadata) : {};
    channelId = meta.channelId || null;
    shipment = meta.shipment || null;
  } catch (e) {
    log.error?.('Failed to parse private_metadata in review modal:', e?.stack || e?.message || e);
  }

  if (!channelId || !shipment) {
    log.error?.('Missing channelId or shipment data in review modal.');
    return;
  }

  // 1) Create the label via Shippo
  let label;
  try {
    label = await createReturnLabelWithShippo(shipment, logger);
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('Failed to create Shippo return label:', e?.stack || msg);
    try {
      await client.chat.postMessage({
        channel: channelId,
        text: `❌ Failed to create Shippo return label: \`${msg}\``
      });
    } catch (postErr) {
      console.error('Additionally failed to post error back to Slack:', postErr?.stack || postErr?.message || postErr);
    }
    return;
  }

  const { trackingNumber, labelUrl, serviceName, etaDays } = label;

  const etaDescription =
    typeof etaDays === 'number'
      ? `${etaDays} business day${etaDays === 1 ? '' : 's'} (estimated)`
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
    // Fall back to at least sending the tracking number + service + ETA
    try {
      await client.chat.postMessage({
        channel: channelId,
        text:
          `✅ Created Shippo return label, but failed to download the PDF.\n` +
          `*Tracking number:* ${trackingNumber || 'N/A'}\n` +
          `*Service:* ${serviceName || 'N/A'}\n` +
          `*ETA:* ${etaDescription}\n` +
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
      channel_id: channelId,
      filename: 'return-label.pdf',
      file: pdfBuffer,
      initial_comment:
        `📦 *Return label created via Shippo*\n` +
        `• *Tracking number:* ${trackingNumber || 'N/A'}\n` +
        `• *Service:* ${serviceName || 'N/A'}\n` +
        `• *ETA:* ${etaDescription}`
    });
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('Failed to upload label PDF to Slack:', e?.stack || msg);
    // Fallback: send tracking number + service + ETA as plain message
    try {
      await client.chat.postMessage({
        channel: channelId,
        text:
          `✅ Created Shippo return label, but failed to upload the PDF to Slack.\n` +
          `*Tracking number:* ${trackingNumber || 'N/A'}\n` +
          `*Service:* ${serviceName || 'N/A'}\n` +
          `*ETA:* ${etaDescription}\n` +
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