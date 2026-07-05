import { CookieJar } from "tough-cookie";

const ALLOWED_TIERS = new Set(["Premium", "Premium+"]);
const YEAR_DURATION = "year";
const X_HANDLE_PATTERN = /^@?[A-Za-z0-9_]{1,15}$/;

export class WebshopError extends Error {
  constructor(message, { status = 500, payload = null } = {}) {
    super(message);
    this.name = "WebshopError";
    this.status = status;
    this.payload = payload;
  }
}

export class WebshopClient {
  constructor({
    origin = "https://lanv.niuma.works",
    entryPath = "/p/niuma",
    fetchImpl = globalThis.fetch,
    jar = new CookieJar(),
  } = {}) {
    if (!fetchImpl) {
      throw new Error("A fetch implementation is required");
    }

    this.origin = new URL(origin).origin;
    this.entryUrl = new URL(entryPath, this.origin).toString();
    this.apiBase = new URL("/addons/telegrambot/webshop/", this.origin);
    this.fetchImpl = fetchImpl;
    this.jar = jar;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    await this.#requestUrl(this.entryUrl, { expectJson: false });
    this.initialized = true;
  }

  async getYearlyPlans() {
    const context = await this.#api("context");
    const plans = [];

    for (const tier of context.tiers ?? []) {
      if (!ALLOWED_TIERS.has(tier.tier)) {
        continue;
      }

      for (const duration of tier.durations ?? []) {
        if (duration.duration !== YEAR_DURATION) {
          continue;
        }

        plans.push({
          tier: tier.tier,
          label: tier.label,
          duration: YEAR_DURATION,
          duration_label: duration.label,
          price: duration.sell_amount,
          original_price: duration.original_price,
          official_price: duration.official_price,
          fulfillment_mode: duration.fulfillment_mode,
          needs_precheck: duration.needs_precheck,
        });
      }
    }

    return {
      plans,
      payment_options: context.chains ?? [],
    };
  }

  async precheck({ xHandle, contactName, notifyEmail }) {
    validateXHandle(xHandle);
    return this.#api("precheck", {
      method: "POST",
      body: {
        x_handle: normalizeXHandle(xHandle),
        ...(contactName ? { username: contactName } : {}),
        ...(notifyEmail ? { notify_email: notifyEmail } : {}),
      },
    });
  }

  async getPrecheckStatus(precheckId) {
    assertPositiveInteger(precheckId, "precheck_id");
    return this.#api(`precheck_status?id=${encodeURIComponent(precheckId)}`);
  }

  async registerPrecheckEmail({ precheckId, notifyEmail }) {
    assertPositiveInteger(precheckId, "precheck_id");
    return this.#api("precheck_notify_email", {
      method: "POST",
      body: {
        precheck_id: Number(precheckId),
        notify_email: notifyEmail,
      },
    });
  }

  async createYearlyOrder({
    tier,
    payChain,
    payToken,
    xHandle,
    contactName,
    notifyEmail,
  }) {
    assertAllowedTier(tier);
    if (xHandle) {
      validateXHandle(xHandle);
    }

    const { plans, payment_options: paymentOptions } =
      await this.getYearlyPlans();
    const plan = plans.find((item) => item.tier === tier);
    if (!plan) {
      throw new WebshopError(`${tier} yearly plan is currently unavailable`, {
        status: 409,
      });
    }

    const paymentOption = paymentOptions.find(
      (item) => item.chain === payChain,
    );
    if (!paymentOption || !paymentOption.tokens?.includes(payToken)) {
      throw new WebshopError(
        `Unsupported payment pair: ${payChain}/${payToken}`,
        { status: 400 },
      );
    }

    return this.#api("create_order", {
      method: "POST",
      body: {
        tier,
        duration: YEAR_DURATION,
        pay_chain: payChain,
        pay_token: payToken,
        ...(xHandle ? { x_handle: normalizeXHandle(xHandle) } : {}),
        ...(contactName ? { username: contactName } : {}),
        ...(notifyEmail ? { notify_email: notifyEmail } : {}),
      },
    });
  }

  async getOrder({ orderNo, queryToken }) {
    const params = new URLSearchParams({ no: orderNo });
    if (queryToken) {
      params.set("token", queryToken);
    }
    return this.#api(`order?${params}`);
  }

  async submitPaymentTx({ orderNo, txHash, queryToken }) {
    return this.#api("submit_tx", {
      method: "POST",
      body: {
        order_no: orderNo,
        tx_hash: txHash,
        ...(queryToken ? { token: queryToken } : {}),
      },
    });
  }

  async #api(path, options = {}) {
    await this.initialize();
    return this.#requestUrl(new URL(path, this.apiBase).toString(), options);
  }

  async #requestUrl(
    url,
    { method = "GET", body, expectJson = true } = {},
  ) {
    const cookie = await this.jar.getCookieString(url);
    const headers = {
      Accept: expectJson ? "application/json" : "text/html,application/xhtml+xml",
    };

    if (cookie) {
      headers.Cookie = cookie;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await this.fetchImpl(url, {
      method,
      headers,
      redirect: "follow",
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    await this.#storeResponseCookies(response, url);

    if (!expectJson) {
      if (!response.ok) {
        throw new WebshopError(`Storefront returned HTTP ${response.status}`, {
          status: response.status,
        });
      }
      await response.text();
      return null;
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new WebshopError("Webshop returned a non-JSON response", {
        status: response.status,
      });
    }

    if (!response.ok || payload?.ok !== true) {
      throw new WebshopError(
        payload?.message ?? `Webshop returned HTTP ${response.status}`,
        { status: response.status, payload },
      );
    }

    return payload;
  }

  async #storeResponseCookies(response, requestUrl) {
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : splitSetCookieHeader(response.headers.get("set-cookie"));

    for (const setCookie of setCookies) {
      await this.jar.setCookie(setCookie, requestUrl);
    }
  }
}

export function assertAllowedTier(tier) {
  if (!ALLOWED_TIERS.has(tier)) {
    throw new WebshopError(
      "Only yearly Premium and Premium+ plans are supported",
      { status: 400 },
    );
  }
}

function validateXHandle(value) {
  if (!X_HANDLE_PATTERN.test(value)) {
    throw new WebshopError(
      "X handle must contain 1-15 letters, numbers, or underscores",
      { status: 400 },
    );
  }
}

function normalizeXHandle(value) {
  return value.replace(/^@/, "");
}

function assertPositiveInteger(value, field) {
  if (!Number.isInteger(Number(value)) || Number(value) <= 0) {
    throw new WebshopError(`${field} must be a positive integer`, {
      status: 400,
    });
  }
}

function splitSetCookieHeader(header) {
  if (!header) {
    return [];
  }
  return header.split(/,(?=[^;,]+=)/);
}
