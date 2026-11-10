import {
  ORDER_STATUS,
  FULFILLMENT_STATUS,
  calculatePaidExchangeRate,
  newPublicId,
  validateOrder
} from "../domain/order.js";

export class OrderNotFoundError extends Error {
  constructor(message = "order not found") {
    super(message);
    this.name = "OrderNotFoundError";
    this.code = "order_not_found";
    this.status = 404;
  }
}

export class OrderConflictError extends Error {
  constructor(message, code = "order_conflict") {
    super(message);
    this.name = "OrderConflictError";
    this.code = code;
    this.status = 409;
  }
}

export class OrderValidationError extends Error {
  constructor(message, code = "invalid_order") {
    super(message);
    this.name = "OrderValidationError";
    this.code = code;
    this.status = 400;
  }
}

export class OrderService {
  constructor(repository) {
    this.repository = repository;
  }

  async submit({
    data,
    config,
    catalog,
    shopId,
    nextUrl,
    provider = "http",
    providerSubmissionId,
    submissionPayload,
    source = "submission"
  }) {
    const validation = validateOrder(data, config, catalog);
    const publicId = newPublicId();
    const submissionId = String(providerSubmissionId || publicId);

    const existing = await this.repository.findSubmission(provider, submissionId);
    if (existing) {
      return {
        order: await this.repository.findById(existing.order_id),
        validation,
        duplicate: true
      };
    }

    let order;
    let duplicate = false;
    try {
      order = await this.repository.createSubmission({
        publicId,
        shopId,
        ordernumber: validation.ordernumber,
        customer: validation.customer,
        shipping: validation.shipping,
        totals: validation.totals,
        nextUrl,
        status: validation.valid ? ORDER_STATUS.VALIDATED : ORDER_STATUS.INVALID,
        items: validation.items,
        addons: validation.addons.map((addon) => ({
          ...addon,
          currency: validation.totals.currency
        })),
        checks: validation.checks,
        submission: {
          provider,
          id: submissionId,
          payload: submissionPayload ?? data
        },
        source
      });
    } catch (error) {
      const raced = await this.repository.findSubmission(provider, submissionId);
      if (!raced) throw error;
      order = await this.repository.findById(raced.order_id);
      duplicate = true;
    }

    return { order, validation, duplicate };
  }

  async status({ shopId, ordernumber }) {
    return this.repository.findStatus(shopId, ordernumber);
  }

  async prepareCheckout({ shopId, orderId, ordernumber }) {
    const order = orderId
      ? await this.repository.findById(orderId)
      : await this.repository.findByOrderNumber(shopId, ordernumber);
    if (!order || (shopId && order.shop_id !== shopId)) {
      throw new OrderNotFoundError();
    }

    if (![ORDER_STATUS.VALIDATED, ORDER_STATUS.PAYMENT_PENDING].includes(order.status)) {
      const error = new OrderConflictError(
        "Only validated orders can create a checkout",
        "order_not_payable"
      );
      error.orderStatus = order.status;
      throw error;
    }

    const [items, addons] = await Promise.all([
      this.repository.findItemsByOrderId(order.id),
      this.repository.findAddonsByOrderId(order.id)
    ]);
    return { order, items, addons };
  }

  async beginCheckout(orderId, sessionId) {
    return this.repository.beginPayment(orderId, { sessionId, source: "checkout" });
  }

  async claim({ shopId, ordernumber, email, message, paymentMethod }) {
    if (!ordernumber || !email) {
      throw new OrderValidationError("Missing required fields", "missing_claim_fields");
    }
    const order = await this.repository.findByOrderNumber(shopId, ordernumber);
    if (!order) throw new OrderNotFoundError();

    if (![ORDER_STATUS.VALIDATED, ORDER_STATUS.PAYMENT_PENDING].includes(order.status)) {
      const error = new OrderConflictError(
        "Only validated or payment-pending orders can be claimed",
        "order_not_claimable"
      );
      error.orderStatus = order.status;
      throw error;
    }

    const existing = await this.repository.findClaimByOrderId(order.id);
    if (existing) {
      throw new OrderConflictError("This order has already been claimed", "claim_exists");
    }

    try {
      return await this.repository.recordClaim(order, {
        shopId,
        ordernumber,
        email,
        message,
        paymentMethod
      });
    } catch (error) {
      const raced = await this.repository.findClaimByOrderId(order.id);
      if (raced) {
        throw new OrderConflictError(
          "This order has already been claimed",
          "claim_exists"
        );
      }
      throw error;
    }
  }

  async recordIntent({
    shopId,
    ordernumber,
    paymentMethod,
    methodLabel,
    source,
    currency,
    ipHash,
    uaHash
  }) {
    if (!ordernumber || !paymentMethod) {
      throw new OrderValidationError("Missing required fields", "missing_intent_fields");
    }
    const order = await this.repository.findByOrderNumber(shopId, ordernumber);
    if (!order) throw new OrderNotFoundError();

    return this.repository.recordIntent(order, {
      shopId,
      paymentMethod,
      methodLabel,
      source,
      currency,
      ipHash,
      uaHash
    });
  }

  async handleWebhook({ provider = "stripe", event }) {
    const eventId = String(event?.id || "");
    if (!eventId) {
      throw new OrderValidationError("Webhook event id is required", "missing_event_id");
    }
    const eventType = String(event?.type || "");
    const existing = await this.repository.findWebhookEvent(provider, eventId);
    if (existing?.processed_at) {
      return { duplicate: true, order: null };
    }

    const session = event.data?.object || {};
    const paidEvent = eventType === "checkout.session.completed" ||
      eventType === "checkout.session.async_payment_succeeded";
    let order = null;
    let payment = null;

    if (paidEvent) {
      const orderId = Number(session.metadata?.order_id || session.client_reference_id || 0);
      const ordernumber = String(session.metadata?.ordernumber || "");
      const shopId = String(session.metadata?.shop_id || "");

      order = orderId
        ? await this.repository.findById(orderId)
        : ordernumber
          ? await this.repository.findByOrderNumber(shopId, ordernumber)
          : null;

      const payable = order && [
        ORDER_STATUS.VALIDATED,
        ORDER_STATUS.PAYMENT_PENDING,
        ORDER_STATUS.CLAIMED
      ].includes(order.status);

      if (payable) {
        const paidCurrency = String(session.currency || "").toUpperCase();
        const paidAmount = Number(session.amount_total ?? 0) / 100;
        const providerRate = session.exchange_rate ??
          session.metadata?.exchange_rate;
        const exchange = calculatePaidExchangeRate({
          total: order.total,
          currency: order.currency,
          paidAmount,
          paidCurrency,
          providerRate
        });
        payment = {
          method: "card",
          sessionId: String(session.id || ""),
          amount: paidAmount,
          currency: paidCurrency,
          exchangeRate: exchange.rate,
          exchangeRateSource: exchange.source,
          fromStatus: order.status,
          source: "webhook",
          message: `event:${eventId}`
        };
      }
    }

    try {
      await this.repository.recordWebhook({
        provider,
        eventId,
        eventType,
        payload: event,
        orderId: payment ? order.id : null,
        payment
      });
    } catch (error) {
      await this.repository.markWebhookError({
        provider,
        eventId,
        error
      }).catch(() => {});
      throw error;
    }

    if (payment) {
      order = await this.repository.findById(order.id);
    }
    return { duplicate: false, order };
  }

  async setFulfillmentStatus({
    orderId,
    fromStatus,
    toStatus,
    source = "fulfillment",
    message = null
  }) {
    if (toStatus === FULFILLMENT_STATUS.UNFULFILLED) {
      throw new OrderConflictError("Cannot return an order to unfulfilled");
    }
    return this.repository.setFulfillmentStatus(orderId, {
      fromStatus,
      toStatus,
      source,
      message
    });
  }
}
