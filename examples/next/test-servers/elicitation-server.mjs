/**
 * Elicitation Test Server
 *
 * A minimal MCP server that exercises the official MCP Elicitation spec
 * (2025-11-25) — https://modelcontextprotocol.io/docs/concepts/elicitation
 *
 * Run alongside examples/next:
 *   node examples/next/test-servers/elicitation-server.mjs
 *
 * Then connect from the Next.js app to:
 *   http://localhost:3100/mcp
 *
 * Tools provided:
 *   - deploy_app        → boolean confirm
 *   - configure_alert   → enum + email + number threshold
 *   - delete_records    → text reason + boolean confirm
 *
 * @requires @modelcontextprotocol/sdk >= 1.29.0
 * @requires express
 */
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';

const PORT = 3100;

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Reusable server factory (one McpServer instance per HTTP session)
// ---------------------------------------------------------------------------
function createServer() {
  const server = new McpServer({
    name: 'elicitation-demo',
    version: '1.0.0',
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 1: deploy_app
  // Demonstrates: boolean schema + enum field
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'deploy_app',
    'Deploy an application to a target environment. Will ask for confirmation.',
    {
      appName: z.string().describe('Name of the application to deploy'),
    },
    async ({ appName }, { requestElicitation }) => {
      const result = await requestElicitation({
        message: `You are about to deploy **${appName}**. Please confirm the target environment.`,
        requestedSchema: {
          type: 'object',
          properties: {
            environment: {
              type: 'string',
              title: 'Target Environment',
              description: 'Which environment should receive this deployment?',
              enum: ['development', 'staging', 'production'],
              enumNames: ['Development', 'Staging', 'Production'],
            },
            confirm: {
              type: 'boolean',
              title: 'I confirm this deployment',
              description: 'Check to confirm you want to proceed.',
              default: false,
            },
          },
          required: ['environment', 'confirm'],
        },
      });

      if (result.action === 'cancel') {
        return { content: [{ type: 'text', text: `🚫 Deployment of **${appName}** was dismissed.` }] };
      }
      if (result.action === 'decline') {
        return { content: [{ type: 'text', text: `❌ Deployment of **${appName}** was declined.` }] };
      }
      if (!result.content?.confirm) {
        return { content: [{ type: 'text', text: `⚠️ Deployment cancelled — confirmation checkbox was not checked.` }] };
      }

      return {
        content: [{
          type: 'text',
          text: `✅ **${appName}** successfully deployed to **${result.content.environment}**.`,
        }],
      };
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 2: configure_alert
  // Demonstrates: string (email format) + enum + number (with min/max)
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'configure_alert',
    'Configure a monitoring alert. Will collect channel, recipient and threshold via a form.',
    {},
    async (_, { requestElicitation }) => {
      const result = await requestElicitation({
        message: 'Configure your monitoring alert settings.',
        requestedSchema: {
          type: 'object',
          properties: {
            channel: {
              type: 'string',
              title: 'Notification Channel',
              description: 'How should the alert be delivered?',
              enum: ['email', 'slack', 'pagerduty'],
              enumNames: ['Email', 'Slack', 'PagerDuty'],
            },
            recipient: {
              type: 'string',
              title: 'Recipient Email',
              description: 'Email address for alert notifications.',
              format: 'email',
            },
            threshold: {
              type: 'number',
              title: 'Alert Threshold (%)',
              description: 'Trigger alert when metric exceeds this percentage.',
              minimum: 1,
              maximum: 100,
            },
          },
          required: ['channel', 'recipient'],
        },
      });

      if (result.action !== 'accept') {
        return { content: [{ type: 'text', text: `Alert configuration ${result.action === 'decline' ? 'declined' : 'dismissed'}.` }] };
      }

      const { channel, recipient, threshold } = result.content ?? {};
      return {
        content: [{
          type: 'text',
          text: [
            `✅ Alert configured successfully:`,
            `• Channel: **${channel}**`,
            `• Recipient: ${recipient}`,
            threshold ? `• Threshold: ${threshold}%` : null,
          ].filter(Boolean).join('\n'),
        }],
      };
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 3: delete_records
  // Demonstrates: string (free text) + boolean (double-confirm pattern)
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'delete_records',
    'Delete records from a dataset. Requires a written reason and explicit confirmation.',
    {
      dataset: z.string().describe('Name of the dataset'),
      count: z.number().int().min(1).describe('Number of records to delete'),
    },
    async ({ dataset, count }, { requestElicitation }) => {
      const result = await requestElicitation({
        message: `⚠️ You are about to permanently delete **${count}** records from **${dataset}**. This action cannot be undone.`,
        requestedSchema: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              title: 'Reason for deletion',
              description: 'Provide a business reason for this deletion (required for audit log).',
              minLength: 10,
              maxLength: 500,
            },
            understood: {
              type: 'boolean',
              title: 'I understand this is permanent',
              description: 'Confirm you understand this deletion cannot be undone.',
              default: false,
            },
          },
          required: ['reason', 'understood'],
        },
      });

      if (result.action === 'cancel') {
        return { content: [{ type: 'text', text: `Operation cancelled. No records were deleted.` }] };
      }
      if (result.action === 'decline') {
        return { content: [{ type: 'text', text: `Deletion declined. No records were deleted.` }] };
      }
      if (!result.content?.understood) {
        return { content: [{ type: 'text', text: `⚠️ Deletion aborted — confirmation checkbox was not checked.` }] };
      }

      return {
        content: [{
          type: 'text',
          text: [
            `✅ ${count} records deleted from **${dataset}**.`,
            `📋 Audit log entry created.`,
            `📝 Reason: "${result.content.reason}"`,
          ].join('\n'),
        }],
      };
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 4: link_account
  // Demonstrates: URL mode elicitation
  // ─────────────────────────────────────────────────────────────────────────
  server.tool(
    'link_account',
    'Link an external account. Requires out-of-band authorization via a secure URL.',
    {
      provider: z.string().describe('Name of the account provider (e.g. github, stripe)'),
    },
    async ({ provider }, { requestElicitation }) => {
      const result = await requestElicitation({
        mode: 'url',
        url: `http://localhost:3000/oauth-mock?provider=${encodeURIComponent(provider)}`,
        message: `⚠️ To link your **${provider}** account, you must authorize access securely.`,
      });

      if (result.action === 'cancel') {
        return { content: [{ type: 'text', text: `Operation cancelled. Account linking was dismissed.` }] };
      }
      if (result.action === 'decline') {
        return { content: [{ type: 'text', text: `Authorization declined. Account linking failed.` }] };
      }

      // If accepted, it means the user consented to open the URL.
      // In a real app, the server would wait for an out-of-band callback (e.g. OAuth redirect)
      // and optionally send a `notifications/elicitation/complete` notification.
      return {
        content: [{
          type: 'text',
          text: [
            `✅ Authorized URL for linking **${provider}** was accepted.`,
            `User is completing the flow out-of-band.`
          ].join('\n'),
        }],
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP handler — one transport per session
// ---------------------------------------------------------------------------
const transports = new Map();

app.post('/mcp', async (req, res) => {
  // Reuse transport for existing session, create new one otherwise
  const sessionId = req.headers['mcp-session-id'] ?? randomUUID();

  let transport = transports.get(sessionId);

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
    });

    const server = createServer();
    await server.connect(transport);
    transports.set(sessionId, transport);

    transport.onclose = () => {
      transports.delete(sessionId);
    };
  }

  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const transport = transports.get(sessionId);
  if (transport) {
    await transport.close();
    transports.delete(sessionId);
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n🚀 Elicitation test server running at http://localhost:${PORT}/mcp`);
  console.log('\nAvailable tools:');
  console.log('  • deploy_app       — form: boolean confirm + enum environment');
  console.log('  • configure_alert  — form: email string + enum + number threshold');
  console.log('  • delete_records   — form: free text reason + boolean confirm');
  console.log('  • link_account     — url: mock authorization flow\n');
  console.log('Connect from examples/next using server URL: http://localhost:3100/mcp');
});
