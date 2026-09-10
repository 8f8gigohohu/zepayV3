import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * Append-only audit trail (§35).
 *
 * Every decision — market data, AI, risk, permission, order, fill, exit, error
 * — is written as one JSON line. Two rules are non-negotiable:
 *
 *   1. **Append-only.** There is no update or delete method. An audit log you
 *      can edit is not an audit log.
 *   2. **Secrets are never written.** Values are passed through a redactor
 *      before serialization, so a stray API key in a payload cannot reach disk.
 */

/**
 * Keys whose values must never be persisted.
 *
 * All entries are **lowercase**, because lookups compare against
 * `key.toLowerCase()`. A camelCase entry here silently matches nothing and
 * leaks the secret — exactly the failure this set exists to prevent.
 */
const SECRET_KEYS = new Set([
  'apisecret', 'apikey', 'secret', 'secretkey', 'signature', 'password',
  'token', 'jwt', 'authorization', 'x-auth-signature', 'x-auth-apikey',
  'privatekey', 'mnemonic', 'seed', 'clientsecret', 'accesstoken', 'refreshtoken',
]);

/** Replace a secret value with a fixed marker. Never logs even a prefix. */
export function redact(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object') {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class AuditLog extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.file]      path for the JSONL sink; omit for in-memory only
   * @param {number} [opts.memoryCap] how many records to retain in memory
   */
  constructor({ file, memoryCap = 1000 } = {}) {
    super();
    this.file = file ?? null;
    this.memoryCap = memoryCap;
    /** @type {Array} in-memory ring buffer, newest last */
    this.records = [];
    this.count = 0;
    if (this.file) mkdirSync(dirname(this.file), { recursive: true });
    this.on('error', () => {});
  }

  /**
   * Append one event.
   * @param {string} type  e.g. `AI_DECISION`, `RISK_VERDICT`, `ORDER_SENT`
   * @param {object} [data]
   * @returns {object} the stored record
   */
  record(type, data = {}) {
    if (!type) throw new TypeError('audit record requires a type');
    const rec = {
      id: `${Date.now().toString(36)}-${(this.count++).toString(36)}`,
      type,
      at: Date.now(),
      iso: new Date().toISOString(),
      data: redact(data),
    };
    this.records.push(rec);
    if (this.records.length > this.memoryCap) this.records.shift();

    if (this.file) {
      try {
        appendFileSync(this.file, `${JSON.stringify(rec)}\n`, 'utf8');
      } catch (err) {
        // A failed disk write must not crash a trading loop, but it must be
        // visible: losing the audit trail silently would be worse than failing.
        this.emit('error', err);
      }
    }
    this.emit('record', rec);
    return rec;
  }

  /** Most recent records, newest last. */
  tail(n = 50, type = null) {
    const src = type ? this.records.filter((r) => r.type === type) : this.records;
    return src.slice(-n);
  }

  /** Count by type — useful for the dashboard's activity view. */
  summary() {
    const byType = {};
    for (const r of this.records) byType[r.type] = (byType[r.type] ?? 0) + 1;
    return { total: this.count, retained: this.records.length, byType, file: this.file };
  }
}
