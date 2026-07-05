import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAllowedTier,
  WebshopClient,
  WebshopError,
} from "../src/webshop-client.js";

test("only Premium and Premium+ tiers are accepted", () => {
  assert.doesNotThrow(() => assertAllowedTier("Premium"));
  assert.doesNotThrow(() => assertAllowedTier("Premium+"));
  assert.throws(
    () => assertAllowedTier("Basic"),
    (error) => error instanceof WebshopError && error.status === 400,
  );
});

test("getYearlyPlans filters out non-year and unsupported plans", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/p/niuma")) {
      return response("<html></html>", {
        contentType: "text/html",
        setCookie: "PHPSESSID=test-session; Path=/; HttpOnly",
      });
    }

    return response({
      ok: true,
      tiers: [
        {
          tier: "Premium",
          label: "Premium",
          durations: [
            { duration: "month", sell_amount: "9.00" },
            {
              duration: "year",
              label: "12个月",
              sell_amount: "47.25",
              original_price: "150",
              official_price: "85",
              fulfillment_mode: "gift",
              needs_precheck: true,
            },
          ],
        },
        {
          tier: "Premium+",
          label: "Premium+",
          durations: [
            {
              duration: "year",
              label: "12个月",
              sell_amount: "210.00",
              original_price: "400",
              official_price: "400",
              fulfillment_mode: "gift",
              needs_precheck: true,
            },
          ],
        },
        {
          tier: "Basic",
          durations: [{ duration: "year", sell_amount: "10.00" }],
        },
      ],
      chains: [{ chain: "base", tokens: ["USDC"] }],
    });
  };

  const client = new WebshopClient({ fetchImpl });
  const result = await client.getYearlyPlans();

  assert.deepEqual(
    result.plans.map(({ tier, duration, price }) => ({
      tier,
      duration,
      price,
    })),
    [
      { tier: "Premium", duration: "year", price: "47.25" },
      { tier: "Premium+", duration: "year", price: "210.00" },
    ],
  );
  assert.deepEqual(result.payment_options, [
    { chain: "base", tokens: ["USDC"] },
  ]);
  assert.equal(calls.length, 2);
});

test("precheck normalizes the leading @ and preserves the PHP session", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/p/niuma")) {
      return response("<html></html>", {
        contentType: "text/html",
        setCookie: "PHPSESSID=test-session; Path=/; HttpOnly",
      });
    }

    return response({
      ok: true,
      passed: true,
      x_handle: "niuma",
    });
  };

  const client = new WebshopClient({ fetchImpl });
  const result = await client.precheck({ xHandle: "@niuma" });

  assert.equal(result.passed, true);
  assert.equal(
    requests[1].options.headers.Cookie,
    "PHPSESSID=test-session",
  );
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    x_handle: "niuma",
  });
});

function response(body, { contentType = "application/json", setCookie } = {}) {
  const payload =
    contentType === "application/json" ? JSON.stringify(body) : body;
  const headers = new Headers({ "content-type": contentType });
  if (setCookie) {
    headers.append("set-cookie", setCookie);
  }
  return new Response(payload, { status: 200, headers });
}
