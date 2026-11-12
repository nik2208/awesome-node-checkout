import { randomBytes } from 'node:crypto';

/**
 * Generates an unpredictable merchant order id for providers that need one when the
 * caller does not pass `orderId` (Nexi `codTrans`, Satispay `external_code`).
 *
 * 'ORD-' + 24 hex chars (96 random bits) = 28 chars: fits Nexi codTrans (max 30) and
 * Satispay external_code. Unlike a timestamp it cannot be enumerated and does not collide
 * across instances or within the same millisecond.
 */
export function generateOrderId(): string {
  return `ORD-${randomBytes(12).toString('hex')}`;
}
