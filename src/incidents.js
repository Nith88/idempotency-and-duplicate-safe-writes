const crypto = require('crypto');
const { db } = require('./db');

const OPERATION = 'POST:/incidents';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

function hashRequest(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

async function createIncident(req, res) {
  const key = req.get('Idempotency-Key');
  if (!key || !key.trim()) return res.status(400).json({ error: 'idempotency_key_required' });

  const { title, severity, serviceId } = req.body;
  const requestHash = hashRequest(req.body);
  const result = await db.tx(async t => {
    let record = await t.oneOrNone(
      `INSERT INTO idempotency_keys
         (tenant_id, operation, key, request_hash, state, expires_at)
       VALUES ($1, $2, $3, $4, 'processing', now() + interval '24 hours')
       ON CONFLICT (tenant_id, operation, key) DO NOTHING
       RETURNING *`,
      [req.user.tenantId, OPERATION, key, requestHash]
    );

    if (!record) {
      record = await t.one(
        `SELECT * FROM idempotency_keys
         WHERE tenant_id = $1 AND operation = $2 AND key = $3
         FOR UPDATE`,
        [req.user.tenantId, OPERATION, key]
      );
    }

    if (record.expires_at <= new Date()) {
      record = await t.one(
        `UPDATE idempotency_keys
         SET request_hash = $4, state = 'processing', status_code = NULL,
             response_body = NULL, expires_at = now() + interval '24 hours',
             updated_at = now()
         WHERE tenant_id = $1 AND operation = $2 AND key = $3
         RETURNING *`,
        [req.user.tenantId, OPERATION, key, requestHash]
      );
    } else if (record.request_hash !== requestHash) {
      return { status: 409, body: { error: 'idempotency_key_conflict' } };
    } else if (record.state === 'completed') {
      return { status: record.status_code, body: record.response_body, replayed: true };
    } else if (record.state === 'processing') {
      return { status: 409, body: { error: 'operation_in_progress' } };
    } else {
      return { status: 409, body: { error: 'prior_operation_failed' } };
    }

    const incident = await t.one(
      `INSERT INTO incidents (tenant_id, service_id, title, severity)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.user.tenantId, serviceId, title, severity]
    );
    await t.none(
      `INSERT INTO paging_jobs (tenant_id, incident_id) VALUES ($1, $2)`,
      [req.user.tenantId, incident.id]
    );
    await t.none(
      `UPDATE idempotency_keys
       SET state = 'completed', status_code = 201, response_body = $2, updated_at = now()
       WHERE id = $1`,
      [record.id, incident]
    );
    return { status: 201, body: incident };
  });

  if (result.replayed) res.set('Idempotent-Replayed', 'true');
  return res.status(result.status).json(result.body);
}

module.exports = { createIncident, hashRequest };
