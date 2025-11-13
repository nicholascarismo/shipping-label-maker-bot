import 'dotenv/config';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import express from 'express';
import boltPkg from '@slack/bolt';

const { App } = boltPkg;

/* =========================
   Env & Config
========================= */

const {
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,       // xapp-... (Socket Mode app-level token)
  SLACK_SIGNING_SECRET,  // not strictly required for Socket Mode, but we keep it wired
  WATCH_CHANNEL_ID,      // optional: default channel to post into
  PORT                   // Express port (healthcheck / future webhooks)
} = process.env;

function mustHave(name) {
  if (!process.env[name] || String(process.env[name]).trim() === '') {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
}

mustHave('SLACK_BOT_TOKEN');
mustHave('SLACK_APP_TOKEN');

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
 *  - Opens a modal asking for default/custom "ship from" and "package info"
 */
slackApp.command('/returnlabel', async ({ ack, body, client, logger }) => {
  await ack();

  const nowIso = new Date().toISOString();

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

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'returnlabel_modal',
        title: {
          type: 'plain_text',
          text: 'Return Label',
          emoji: true
        },
        submit: {
          type: 'plain_text',
          text: 'Continue',
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
              text: 'Configure your return label options.'
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'input',
            block_id: 'ship_from_choice_block',
            label: {
              type: 'plain_text',
              text: 'Ship From Address',
              emoji: true
            },
            element: {
              type: 'radio_buttons',
              action_id: 'ship_from_choice',
              initial_option: {
                text: {
                  type: 'plain_text',
                  text: 'Use default ship-from address',
                  emoji: true
                },
                value: 'default_ship_from'
              },
              options: [
                {
                  text: {
                    type: 'plain_text',
                    text: 'Use default ship-from address',
                    emoji: true
                  },
                  value: 'default_ship_from'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Enter a custom ship-from address',
                    emoji: true
                  },
                  value: 'custom_ship_from'
                }
              ]
            }
          },
          {
            type: 'input',
            block_id: 'package_info_choice_block',
            label: {
              type: 'plain_text',
              text: 'Package Info',
              emoji: true
            },
            element: {
              type: 'radio_buttons',
              action_id: 'package_info_choice',
              initial_option: {
                text: {
                  type: 'plain_text',
                  text: 'Use default package info',
                  emoji: true
                },
                value: 'default_package_info'
              },
              options: [
                {
                  text: {
                    type: 'plain_text',
                    text: 'Use default package info',
                    emoji: true
                  },
                  value: 'default_package_info'
                },
                {
                  text: {
                    type: 'plain_text',
                    text: 'Enter custom package info',
                    emoji: true
                  },
                  value: 'custom_package_info'
                }
              ]
            }
          }
        ]
      }
    });
  } catch (e) {
    console.error('Failed to open /returnlabel modal:', e?.stack || e?.message || e);
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