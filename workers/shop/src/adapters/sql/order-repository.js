import {
  FULFILLMENT_STATUS,
  ORDER_STATUS
} from "../../domain/order.js";

function statement(sql, params = []) {
  return { sql, params };
}

function orderIdSelect(publicId) {
  return "SELECT id FROM orders WHERE public_id = ?";
}

function itemStatements(publicId, items) {
  return items.map((item, position) => statement(`
    INSERT INTO order_items (
      order_id, position, sku, title, variant, quantity,
      unit_price, line_total, currency
    )
    SELECT id, ?, ?, ?, ?, ?, ?, ?, ? FROM orders WHERE public_id = ?
  `, [
    position,
    item.sku,
    item.title || "",
    item.variant || "",
    item.quantity,
    item.unit_price,
    item.line_total,
    item.currency,
    publicId
  ]));
}

function addonStatements(publicId, addons) {
  return addons.map((addon, position) => statement(`
    INSERT INTO order_addons (
      order_id, position, group_name, value, title, price, currency
    )
    SELECT id, ?, ?, ?, ?, ?, ? FROM orders WHERE public_id = ?
  `, [
    position,
    addon.group,
    addon.value,
    addon.title || "",
    addon.price,
    addon.currency || "",
    publicId
  ]));
}

function checkStatements(publicId, checks) {
  return checks.map((check, position) => statement(`
    INSERT INTO order_validation_checks (
      order_id, position, check_name, passed, message
    )
    SELECT id, ?, ?, ?, ? FROM orders WHERE public_id = ?
  `, [
    position,
    check.check,
    check.passed ? 1 : 0,
    check.message || "",
    publicId
  ]));
}

function historyStatement(publicId, {
  statusType = "order",
  fromStatus = null,
  toStatus,
  source = "system",
  message = null,
  requireStatus = null,
  requireFulfillment = null
}) {
  const conditions = ["public_id = ?"];
  const params = [statusType, fromStatus, toStatus, source, message, publicId];
  if (requireStatus) {
    conditions.push("status = ?");
    params.push(requireStatus);
  }
  if (requireFulfillment) {
    conditions.push("fulfillment_status = ?");
    params.push(requireFulfillment);
  }
  return statement(`
    INSERT INTO order_status_history (
      order_id, status_type, from_status, to_status, source, message
    )
    SELECT id, ?, ?, ?, ?, ? FROM orders WHERE ${conditions.join(" AND ")}
  `, params);
}

function paymentStatements(orderId, payment) {
  const statements = [
    statement(`
      UPDATE orders
      SET status = 'paid',
          fulfillment_status = CASE
            WHEN fulfillment_status = 'unfulfilled' THEN 'fulfillment_pending'
            ELSE fulfillment_status
          END,
          payment_method = ?,
          stripe_session_id = COALESCE(?, stripe_session_id),
          paid_amount = ?,
          paid_currency = ?,
          paid_exchange_rate = ?,
          paid_exchange_rate_source = ?,
          paid_exchange_rate_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END,
          updated_at = datetime('now')
      WHERE id = ?
        AND status IN ('validated', 'payment_pending', 'claimed')
    `, [
      payment.method || null,
      payment.sessionId || null,
      payment.amount,
      payment.currency,
      payment.exchangeRate,
      payment.exchangeRateSource,
      payment.exchangeRate,
      orderId
    ]),
    statement(`
      INSERT INTO order_status_history (
        order_id, status_type, from_status, to_status, source, message
      )
      SELECT ?, 'order', ?, 'paid', ?, ?
      WHERE EXISTS (
        SELECT 1 FROM orders WHERE id = ? AND status = 'paid'
      )
      AND NOT EXISTS (
        SELECT 1 FROM order_status_history
        WHERE order_id = ? AND status_type = 'order' AND to_status = 'paid'
      )
    `, [
      orderId,
      payment.fromStatus || null,
      payment.source || "payment",
      payment.message || null,
      orderId,
      orderId
    ]),
    statement(`
      INSERT INTO order_status_history (
        order_id, status_type, from_status, to_status, source, message
      )
      SELECT ?, 'fulfillment', 'unfulfilled', 'fulfillment_pending', ?, ?
      WHERE EXISTS (
        SELECT 1 FROM orders WHERE id = ? AND fulfillment_status = 'fulfillment_pending'
      )
      AND NOT EXISTS (
        SELECT 1 FROM order_status_history
        WHERE order_id = ? AND status_type = 'fulfillment' AND to_status = 'fulfillment_pending'
      )
    `, [
      orderId,
      payment.source || "payment",
      payment.message || null,
      orderId,
      orderId
    ])
  ];
  return statements;
}

export class SqlOrderRepository {
  constructor(executor) {
    this.executor = executor;
  }

  async createSubmission({
    publicId,
    shopId,
    ordernumber,
    customer,
    shipping,
    totals,
    nextUrl,
    ipHash,
    uaHash,
    status = ORDER_STATUS.SUBMITTED,
    items = [],
    addons = [],
    checks = [],
    submission,
    source = "submission"
  }) {
    const finalStatus = status;
    const finalFulfillment = finalStatus === ORDER_STATUS.INVALID
      ? FULFILLMENT_STATUS.CANCELLED
      : FULFILLMENT_STATUS.UNFULFILLED;
    const statements = [
      statement(`
        INSERT INTO orders (
          public_id, shop_id, ordernumber, firstname, lastname, email,
          address, zipcode, city, country, message, shipping_title,
          shipping_label, currency, subtotal, shipping_cost, addons_total,
          total, status, fulfillment_status, next_url, ip_hash, ua_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        publicId,
        shopId,
        ordernumber,
        customer.firstname,
        customer.lastname,
        customer.email,
        customer.address,
        customer.zipcode,
        customer.city,
        customer.country,
        customer.message || "",
        shipping.title,
        shipping.label,
        totals.currency,
        totals.subtotal,
        totals.shipping,
        totals.addons,
        totals.total,
        ORDER_STATUS.SUBMITTED,
        FULFILLMENT_STATUS.UNFULFILLED,
        nextUrl || null,
        ipHash || null,
        uaHash || null
      ])
    ];

    if (submission) {
      statements.push(statement(`
        INSERT INTO order_submissions (
          order_id, provider, provider_submission_id, payload
        )
        SELECT id, ?, ?, ? FROM orders WHERE public_id = ?
      `, [
        submission.provider,
        submission.id,
        JSON.stringify(submission.payload ?? null),
        publicId
      ]));
    }

    if (finalStatus !== ORDER_STATUS.SUBMITTED) {
      statements.push(
        ...itemStatements(publicId, items),
        ...addonStatements(publicId, addons),
        ...checkStatements(publicId, checks)
      );
    }

    statements.push(historyStatement(publicId, {
      toStatus: ORDER_STATUS.SUBMITTED,
      source,
      message: null
    }));

    if (finalStatus !== ORDER_STATUS.SUBMITTED) {
      statements.push(
        statement(`
          UPDATE orders
          SET status = ?, fulfillment_status = ?, updated_at = datetime('now')
          WHERE public_id = ? AND status = 'submitted'
        `, [finalStatus, finalFulfillment, publicId]),
        historyStatement(publicId, {
          fromStatus: ORDER_STATUS.SUBMITTED,
          toStatus: finalStatus,
          source,
          message: null,
          requireStatus: finalStatus
        })
      );
      if (finalStatus === ORDER_STATUS.INVALID) {
        statements.push(historyStatement(publicId, {
          statusType: "fulfillment",
          fromStatus: FULFILLMENT_STATUS.UNFULFILLED,
          toStatus: FULFILLMENT_STATUS.CANCELLED,
          source,
          message: null,
          requireFulfillment: FULFILLMENT_STATUS.CANCELLED
        }));
      }
    }

    await this.executor.execute(statements);
    return this.findByPublicId(publicId);
  }

  async applyValidation(publicId, validation, source = "validation") {
    const finalStatus = validation.valid
      ? ORDER_STATUS.VALIDATED
      : ORDER_STATUS.INVALID;
    const finalFulfillment = validation.valid
      ? FULFILLMENT_STATUS.UNFULFILLED
      : FULFILLMENT_STATUS.CANCELLED;
    const statements = [
      statement(`
        DELETE FROM order_items
        WHERE order_id = (${orderIdSelect(publicId)})
      `, [publicId]),
      statement(`
        DELETE FROM order_addons
        WHERE order_id = (${orderIdSelect(publicId)})
      `, [publicId]),
      statement(`
        DELETE FROM order_validation_checks
        WHERE order_id = (${orderIdSelect(publicId)})
      `, [publicId]),
      ...itemStatements(publicId, validation.items),
      ...addonStatements(publicId, validation.addons),
      ...checkStatements(publicId, validation.checks),
      statement(`
        UPDATE orders
        SET status = ?, fulfillment_status = ?, updated_at = datetime('now')
        WHERE public_id = ? AND status = 'submitted'
      `, [finalStatus, finalFulfillment, publicId]),
      historyStatement(publicId, {
        fromStatus: ORDER_STATUS.SUBMITTED,
        toStatus: finalStatus,
        source,
        message: null,
        requireStatus: finalStatus
      })
    ];
    if (finalStatus === ORDER_STATUS.INVALID) {
      statements.push(historyStatement(publicId, {
        statusType: "fulfillment",
        fromStatus: FULFILLMENT_STATUS.UNFULFILLED,
        toStatus: FULFILLMENT_STATUS.CANCELLED,
        source,
        message: null,
        requireFulfillment: FULFILLMENT_STATUS.CANCELLED
      }));
    }
    await this.executor.execute(statements);
    return this.findByPublicId(publicId);
  }

  async beginPayment(orderId, { sessionId = null, source = "checkout" } = {}) {
    await this.executor.execute([
      statement(`
        UPDATE orders
        SET status = 'payment_pending',
            stripe_session_id = COALESCE(?, stripe_session_id),
            updated_at = datetime('now')
        WHERE id = ? AND status IN ('validated', 'payment_pending')
      `, [sessionId, orderId]),
      statement(`
        INSERT INTO order_status_history (
          order_id, status_type, from_status, to_status, source, message
        )
        SELECT ?, 'order', 'validated', 'payment_pending', ?, NULL
        WHERE EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = 'payment_pending')
        AND NOT EXISTS (
          SELECT 1 FROM order_status_history
          WHERE order_id = ? AND status_type = 'order' AND to_status = 'payment_pending'
        )
      `, [orderId, source, orderId, orderId])
    ]);
    return this.findById(orderId);
  }

  async recordClaim(order, claim) {
    const fromStatus = order.status;
    await this.executor.execute([
      statement(`
        INSERT INTO claims (
          shop_id, order_id, ordernumber, email, message, payment_method
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
        claim.shopId,
        order.id,
        claim.ordernumber,
        claim.email,
        claim.message || "",
        claim.paymentMethod || null
      ]),
      statement(`
        UPDATE orders
        SET status = 'claimed',
            payment_method = COALESCE(?, payment_method),
            updated_at = datetime('now')
        WHERE id = ? AND status IN ('validated', 'payment_pending')
      `, [claim.paymentMethod || null, order.id]),
      statement(`
        INSERT INTO order_status_history (
          order_id, status_type, from_status, to_status, source, message
        )
        SELECT ?, 'order', ?, 'claimed', 'claim', ?
        WHERE EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = 'claimed')
        AND NOT EXISTS (
          SELECT 1 FROM order_status_history
          WHERE order_id = ? AND status_type = 'order' AND to_status = 'claimed'
        )
      `, [order.id, fromStatus, claim.message || null, order.id, order.id])
    ]);
    return this.findById(order.id);
  }

  async recordPayment(orderId, payment) {
    await this.executor.execute(paymentStatements(orderId, payment));
    return this.findById(orderId);
  }

  async recordIntent(order, intent) {
    await this.executor.execute([
      statement(`
        INSERT INTO payment_intents (
          shop_id, order_id, ordernumber, payment_method,
          method_label, source, currency, ip_hash, ua_hash
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        intent.shopId,
        order.id,
        order.ordernumber,
        intent.paymentMethod,
        intent.methodLabel || null,
        intent.source || "link",
        intent.currency || null,
        intent.ipHash || null,
        intent.uaHash || null
      ]),
      statement(`
        UPDATE orders
        SET payment_method = ?, updated_at = datetime('now')
        WHERE id = ?
      `, [intent.paymentMethod, order.id])
    ]);
    return this.findById(order.id);
  }

  async recordWebhook({
    provider,
    eventId,
    eventType,
    payload,
    orderId = null,
    payment = null
  }) {
    const statements = [
      statement(`
        INSERT INTO webhook_events (provider, event_id, event_type, payload)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(provider, event_id) DO NOTHING
      `, [provider, eventId, eventType || null, JSON.stringify(payload)])
    ];
    if (orderId && payment) {
      statements.push(...paymentStatements(orderId, payment));
    }
    statements.push(statement(`
      UPDATE webhook_events
      SET attempts = attempts + 1,
          last_error = NULL,
          processed_at = COALESCE(processed_at, datetime('now'))
      WHERE provider = ? AND event_id = ?
    `, [provider, eventId]));
    await this.executor.execute(statements);
  }

  async markWebhookError({ provider, eventId, error }) {
    await this.executor.execute([
      statement(`
        UPDATE webhook_events
        SET attempts = attempts + 1, last_error = ?
        WHERE provider = ? AND event_id = ?
      `, [String(error?.message || error || "unknown error"), provider, eventId])
    ]);
  }

  async setFulfillmentStatus(orderId, {
    fromStatus,
    toStatus,
    source = "fulfillment",
    message = null
  }) {
    await this.executor.execute([
      statement(`
        UPDATE orders
        SET fulfillment_status = ?, updated_at = datetime('now')
        WHERE id = ? AND fulfillment_status = ?
      `, [toStatus, orderId, fromStatus]),
      statement(`
        INSERT INTO order_status_history (
          order_id, status_type, from_status, to_status, source, message
        )
        SELECT ?, 'fulfillment', ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM orders WHERE id = ? AND fulfillment_status = ?)
        AND NOT EXISTS (
          SELECT 1 FROM order_status_history
          WHERE order_id = ? AND status_type = 'fulfillment' AND to_status = ?
        )
      `, [
        orderId,
        fromStatus,
        toStatus,
        source,
        message,
        orderId,
        toStatus,
        orderId,
        toStatus
      ])
    ]);
    return this.findById(orderId);
  }

  async findById(orderId) {
    return this.executor.first("SELECT * FROM orders WHERE id = ?", [orderId]);
  }

  async findItemsByOrderId(orderId) {
    return this.executor.all(
      "SELECT * FROM order_items WHERE order_id = ? ORDER BY position",
      [orderId]
    );
  }

  async findAddonsByOrderId(orderId) {
    return this.executor.all(
      "SELECT * FROM order_addons WHERE order_id = ? ORDER BY position",
      [orderId]
    );
  }

  async findByPublicId(publicId) {
    return this.executor.first("SELECT * FROM orders WHERE public_id = ?", [publicId]);
  }

  async findByOrderNumber(shopId, ordernumber) {
    return this.executor.first(`
      SELECT * FROM orders
      WHERE ordernumber = ? AND shop_id = ?
      ORDER BY id DESC LIMIT 1
    `, [ordernumber, shopId]);
  }

  async findStatus(shopId, ordernumber) {
    return this.executor.first(`
      SELECT o.id, o.public_id, o.ordernumber, o.status, o.fulfillment_status,
             o.currency, o.subtotal, o.shipping_cost, o.addons_total, o.total,
             (
               SELECT h.created_at FROM order_status_history h
               WHERE h.order_id = o.id
                 AND h.status_type = 'order'
                 AND h.to_status = 'validated'
               ORDER BY h.id LIMIT 1
             ) AS validated_at
      FROM orders o
      WHERE o.ordernumber = ? AND o.shop_id = ?
      ORDER BY o.id DESC LIMIT 1
    `, [ordernumber, shopId]);
  }

  async findClaimByOrderId(orderId) {
    return this.executor.first(
      "SELECT * FROM claims WHERE order_id = ? ORDER BY id DESC LIMIT 1",
      [orderId]
    );
  }

  async findSubmission(provider, providerSubmissionId) {
    return this.executor.first(`
      SELECT * FROM order_submissions
      WHERE provider = ? AND provider_submission_id = ?
      LIMIT 1
    `, [provider, providerSubmissionId]);
  }

  async findWebhookEvent(provider, eventId) {
    return this.executor.first(
      "SELECT * FROM webhook_events WHERE provider = ? AND event_id = ?",
      [provider, eventId]
    );
  }
}
