import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { z } from "zod";

import { WebshopClient, WebshopError } from "./webshop-client.js";

const port = Number(process.env.PORT ?? 3000);
const origin =
  process.env.WEBSHOP_ORIGIN ?? "https://lanv.niuma.works";
const entryPath = process.env.WEBSHOP_ENTRY_PATH ?? "/p/niuma";
const allowedHosts = new Set(
  (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

const sessions = new Map();

app.use((req, res, next) => {
  if (allowedHosts.size === 0) {
    next();
    return;
  }

  const host = req.hostname.toLowerCase();
  if (!allowedHosts.has(host)) {
    res.status(403).json({ error: "Host is not allowed" });
    return;
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "niuma-premium-mcp" });
});

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.header("mcp-session-id");
    const existing = sessionId ? sessions.get(sessionId) : undefined;

    if (existing) {
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId || !isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing MCP session" },
        id: null,
      });
      return;
    }

    const webshop = new WebshopClient({ origin, entryPath });
    const server = createServer(webshop);
    let transport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, { server, transport });
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
    console.error("MCP request failed", safeError(error));
  }
});

for (const method of ["get", "delete"]) {
  app[method]("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(400).send("Invalid or missing MCP session");
      return;
    }
    await session.transport.handleRequest(req, res);
  });
}

const httpServer = app.listen(port, "0.0.0.0", () => {
  console.log(`NIUMA Premium MCP listening on port ${port}`);
});

async function shutdown() {
  httpServer.close();
  await Promise.allSettled(
    [...sessions.values()].map(({ server }) => server.close()),
  );
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function createServer(webshop) {
  const server = new McpServer({
    name: "niuma-premium",
    version: "1.0.0",
  });

  server.registerTool(
    "list_yearly_plans",
    {
      title: "查询年度套餐",
      description:
        "查询 NIUMA 当前可用的 X Premium 与 Premium+ 年费套餐、实时价格和付款网络。",
      inputSchema: z.object({}),
    },
    async () => toolCall(() => webshop.getYearlyPlans()),
  );

  server.registerTool(
    "check_gift_eligibility",
    {
      title: "检查赠送开通资格",
      description:
        "提交 X 账号，检查是否具备 Premium 或 Premium+ 年费赠送开通资格。",
      inputSchema: z.object({
        x_handle: z.string().describe("X 用户名，可带或不带 @"),
        contact_name: z.string().optional().describe("联系人备注"),
        notify_email: z.string().email().optional().describe("通知邮箱"),
      }),
    },
    async ({ x_handle, contact_name, notify_email }) =>
      toolCall(() =>
        webshop.precheck({
          xHandle: x_handle,
          contactName: contact_name,
          notifyEmail: notify_email,
        }),
      ),
  );

  server.registerTool(
    "get_eligibility_status",
    {
      title: "查询资格检查状态",
      description: "查询异步 X 账号资格检查的最新状态。",
      inputSchema: z.object({
        precheck_id: z.number().int().positive(),
      }),
    },
    async ({ precheck_id }) =>
      toolCall(() => webshop.getPrecheckStatus(precheck_id)),
  );

  server.registerTool(
    "register_precheck_email",
    {
      title: "登记开通通知邮箱",
      description: "资格暂未通过时，登记可开通后的通知邮箱。",
      inputSchema: z.object({
        precheck_id: z.number().int().positive(),
        notify_email: z.string().email(),
      }),
    },
    async ({ precheck_id, notify_email }) =>
      toolCall(() =>
        webshop.registerPrecheckEmail({
          precheckId: precheck_id,
          notifyEmail: notify_email,
        }),
      ),
  );

  server.registerTool(
    "create_yearly_order",
    {
      title: "创建年度套餐订单",
      description:
        "在资格检查通过后，创建 X Premium 或 Premium+ 年费订单。套餐时长固定为一年。",
      inputSchema: z.object({
        tier: z.enum(["Premium", "Premium+"]),
        pay_chain: z.string().min(1),
        pay_token: z.string().min(1),
        x_handle: z.string().optional(),
        contact_name: z.string().optional(),
        notify_email: z.string().email().optional(),
      }),
    },
    async ({
      tier,
      pay_chain,
      pay_token,
      x_handle,
      contact_name,
      notify_email,
    }) =>
      toolCall(() =>
        webshop.createYearlyOrder({
          tier,
          payChain: pay_chain,
          payToken: pay_token,
          xHandle: x_handle,
          contactName: contact_name,
          notifyEmail: notify_email,
        }),
      ),
  );

  server.registerTool(
    "get_order",
    {
      title: "查询订单",
      description: "查询订单付款与开通状态。",
      inputSchema: z.object({
        order_no: z.string().min(1),
        query_token: z.string().optional(),
      }),
    },
    async ({ order_no, query_token }) =>
      toolCall(() =>
        webshop.getOrder({
          orderNo: order_no,
          queryToken: query_token,
        }),
      ),
  );

  server.registerTool(
    "submit_payment_tx",
    {
      title: "提交付款交易哈希",
      description: "提交客户已完成的链上付款交易哈希，加速订单确认。",
      inputSchema: z.object({
        order_no: z.string().min(1),
        tx_hash: z.string().min(1),
        query_token: z.string().optional(),
      }),
    },
    async ({ order_no, tx_hash, query_token }) =>
      toolCall(() =>
        webshop.submitPaymentTx({
          orderNo: order_no,
          txHash: tx_hash,
          queryToken: query_token,
        }),
      ),
  );

  return server;
}

async function toolCall(operation) {
  try {
    const data = await operation();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
    };
  } catch (error) {
    const message =
      error instanceof WebshopError
        ? error.message
        : "The NIUMA webshop request failed";
    return {
      isError: true,
      content: [{ type: "text", text: message }],
    };
  }
}

function safeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? "Unknown error",
  };
}
