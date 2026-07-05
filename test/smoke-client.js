import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.MCP_URL ?? "http://127.0.0.1:3100/mcp";
const client = new Client({
  name: "niuma-premium-smoke-test",
  version: "1.0.0",
});

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));

  const { tools } = await client.listTools();
  assert.equal(tools.length, 7);
  assert.ok(tools.some(({ name }) => name === "list_yearly_plans"));

  const result = await client.callTool({
    name: "list_yearly_plans",
    arguments: {},
  });
  assert.equal(result.isError, undefined);

  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(
    payload.plans.map(({ tier, duration }) => ({ tier, duration })),
    [
      { tier: "Premium", duration: "year" },
      { tier: "Premium+", duration: "year" },
    ],
  );

  console.log(
    JSON.stringify({
      ok: true,
      endpoint,
      tools: tools.map(({ name }) => name),
      plans: payload.plans.map(({ tier, price }) => ({ tier, price })),
    }),
  );
} finally {
  await client.close();
}
