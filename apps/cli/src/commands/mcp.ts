import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Command } from 'commander';

import pkg from '../../package.json' with { type: 'json' };

/**
 * A local stdio bridge to a remote Knoverge endpoint.
 *
 * Every MCP host speaks stdio; not every one speaks Streamable HTTP, and
 * fewer still let a person attach an Authorization header to it. This is the
 * shim that closes that gap: it reads JSON-RPC from stdin, forwards it to
 * `/mcp` with the token from the environment, and writes the answer back.
 *
 * It holds no state and understands no messages. Anything the two ends agree
 * on passes through unchanged, so a tool added to the server needs nothing
 * here — which is the only way a bridge stays correct.
 */
export function mcpCommand(): Command {
  const mcp = new Command('mcp').description('Talk to a Knoverge MCP endpoint');

  mcp
    .command('stdio')
    .description('Bridge stdin and stdout to a remote MCP endpoint')
    .option('--url <url>', 'the endpoint, or KNOVERGE_MCP_URL')
    .option('--workspace <slug>', 'which workspace, for a token that could mean several')
    .action(async (options: { url?: string; workspace?: string }) => {
      const url = options.url ?? process.env['KNOVERGE_MCP_URL'];
      // The token never becomes an argument: a command line is visible to
      // every process on the machine and ends up in shell history.
      const token = process.env['KNOVERGE_TOKEN'];
      if (!url) throw new Error('give --url or set KNOVERGE_MCP_URL');
      if (!token) throw new Error('set KNOVERGE_TOKEN to an agent credential');

      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (options.workspace) headers['x-knoverge-workspace'] = options.workspace;

      const remote = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers },
      }) as unknown as Transport;
      const local = new StdioServerTransport() as unknown as Transport;

      // Two transports wired to each other. Nothing is parsed: a message that
      // arrives is a message that leaves, so the bridge cannot disagree with
      // either end about what a tool means.
      local.onmessage = (message) => void remote.send(message);
      remote.onmessage = (message) => void local.send(message);
      local.onclose = () => void remote.close();
      remote.onclose = () => void local.close();
      // stderr, because stdout is the protocol.
      remote.onerror = (error) => process.stderr.write(`knoverge: ${error.message}\n`);
      local.onerror = (error) => process.stderr.write(`knoverge: ${error.message}\n`);

      await remote.start();
      await local.start();

      await new Promise<void>((resolve) => {
        const stop = () => {
          void local.close();
          void remote.close();
          resolve();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        process.stdin.once('end', stop);
      });
    });

  mcp
    .command('check')
    .description('Connect to an endpoint and list the tools it offers')
    .option('--url <url>', 'the endpoint, or KNOVERGE_MCP_URL')
    .action(async (options: { url?: string }) => {
      const url = options.url ?? process.env['KNOVERGE_MCP_URL'];
      const token = process.env['KNOVERGE_TOKEN'];
      if (!url) throw new Error('give --url or set KNOVERGE_MCP_URL');
      if (!token) throw new Error('set KNOVERGE_TOKEN to an agent credential');

      const client = new Client({ name: 'knoverge-cli', version: pkg.version });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }) as unknown as Transport,
      );
      try {
        const { tools } = await client.listTools();
        console.log(`${url}: ${tools.length} tool(s)`);
        for (const tool of tools) console.log(`  ${tool.name}`);
      } finally {
        await client.close();
      }
    });

  return mcp;
}
