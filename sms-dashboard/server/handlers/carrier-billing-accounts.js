function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function idempotencyContext(request) {
  const actor = request.user?.id;
  const key = request.headers.get('Idempotency-Key')?.trim();
  if (!actor) return { error: json({ error: 'Unauthorized' }, 401) };
  if (!key || key.length > 200) {
    return { error: json({ error: 'A bounded Idempotency-Key header is required' }, 400) };
  }
  return { actor, key };
}

async function readJson(request) {
  try {
    return { body: await request.json() };
  } catch {
    return { error: json({ error: 'Body must be JSON' }, 400) };
  }
}

async function findIdempotentEvent(db, actor, key) {
  return db.prepare(`
    SELECT billing_account_id, event_type
    FROM carrier_billing_account_events
    WHERE actor_subject = ? AND idempotency_key = ?
  `).bind(actor, key).first();
}

async function accountDetail(db, id) {
  const account = await db.prepare(`
    SELECT
      a.id, a.country_code, a.carrier, a.currency, a.display_name,
      a.notification_sim_iccid, a.account_ref_last4, a.status,
      a.version, a.created_at, a.updated_at,
      d.sim_index AS notification_sim_index,
      d.number AS notification_sim_number
    FROM carrier_billing_accounts a
    LEFT JOIN device_view d ON d.iccid = a.notification_sim_iccid
    WHERE a.id = ?
  `).bind(id).first();
  if (!account) return null;
  const members = await db.prepare(`
    SELECT
      s.sim_iccid AS iccid,
      d.sim_index,
      d.number,
      s.verification_source,
      s.verified_at,
      s.verified_by
    FROM carrier_billing_account_sims s
    LEFT JOIN device_view d ON d.iccid = s.sim_iccid
    WHERE s.billing_account_id = ? AND s.removed_at IS NULL
    ORDER BY d.sim_index, s.sim_iccid
  `).bind(id).all();
  return {
    id: account.id,
    country_code: account.country_code,
    carrier: account.carrier,
    currency: account.currency,
    display_name: account.display_name,
    account_ref_masked: `•••• ${account.account_ref_last4}`,
    status: account.status,
    version: account.version,
    created_at: account.created_at,
    updated_at: account.updated_at,
    notification_sim: {
      iccid: account.notification_sim_iccid,
      sim_index: account.notification_sim_index,
      number: account.notification_sim_number,
    },
    linked_sims: members.results ?? [],
  };
}

function memberRequest(body) {
  const expectedVersion = body?.expected_version;
  const simIccids = body?.sim_iccids;
  const verificationSource = body?.verification_source;
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return { error: 'expected_version must be a positive integer' };
  }
  if (!Array.isArray(simIccids)
    || simIccids.length < 1
    || simIccids.length > 100
    || simIccids.some((value) => typeof value !== 'string' || !value.trim())
    || new Set(simIccids).size !== simIccids.length) {
    return { error: 'sim_iccids must be a unique non-empty list of at most 100 ICCIDs' };
  }
  if (!['carrier_account', 'contract_or_bill', 'carrier_support'].includes(verificationSource)) {
    return { error: 'verification_source is invalid' };
  }
  return {
    expectedVersion,
    simIccids: simIccids.slice().sort(),
    verificationSource,
  };
}

async function buildMemberPreview(db, accountId, input) {
  const account = await db.prepare(`
    SELECT id, country_code, carrier, notification_sim_iccid, version
    FROM carrier_billing_accounts WHERE id = ?
  `).bind(accountId).first();
  if (!account) return { response: json({ error: 'Billing account not found' }, 404) };
  if (account.version !== input.expectedVersion) {
    return {
      response: json({ error: 'Billing account version conflict', current_version: account.version }, 409),
    };
  }

  const placeholders = input.simIccids.map(() => '?').join(', ');
  const [inventoryResult, activeResult, currentResult] = await Promise.all([
    db.prepare(`
      SELECT iccid, sim_index, number, country, carrier, service_type
      FROM device_view WHERE iccid IN (${placeholders})
      ORDER BY sim_index, iccid
    `).bind(...input.simIccids).all(),
    db.prepare(`
      SELECT sim_iccid, billing_account_id
      FROM carrier_billing_account_sims
      WHERE sim_iccid IN (${placeholders}) AND removed_at IS NULL
    `).bind(...input.simIccids).all(),
    db.prepare(`
      SELECT sim_iccid
      FROM carrier_billing_account_sims
      WHERE billing_account_id = ? AND removed_at IS NULL
      ORDER BY sim_iccid
    `).bind(accountId).all(),
  ]);
  const inventory = new Map((inventoryResult.results ?? []).map((sim) => [sim.iccid, sim]));
  const active = new Map((activeResult.results ?? []).map((row) => [row.sim_iccid, row.billing_account_id]));
  const current = (currentResult.results ?? []).map((row) => row.sim_iccid);
  const currentSet = new Set(current);
  const requestedSet = new Set(input.simIccids);
  const eligible = [];
  const ineligible = [];

  for (const iccid of input.simIccids) {
    const sim = inventory.get(iccid);
    let reason = null;
    if (!sim) reason = 'not_found';
    else if (sim.country !== account.country_code) reason = 'country_mismatch';
    else if (sim.carrier !== account.carrier) reason = 'carrier_mismatch';
    else if (sim.service_type !== 'postpaid') reason = 'not_postpaid';
    else if (active.has(iccid) && active.get(iccid) !== accountId) reason = 'linked_to_another_account';
    if (reason) ineligible.push({ iccid, reason });
    else eligible.push(sim);
  }

  const digestPayload = JSON.stringify({
    account_id: accountId,
    expected_version: input.expectedVersion,
    sim_iccids: input.simIccids,
    verification_source: input.verificationSource,
  });
  return {
    account,
    current,
    eligible,
    ineligible,
    preview_digest: await sha256(digestPayload),
    summary: {
      requested: input.simIccids.length,
      eligible: eligible.length,
      ineligible: ineligible.length,
      add: eligible.filter((sim) => !currentSet.has(sim.iccid)).length,
      remove: current.filter((iccid) => !requestedSet.has(iccid)).length,
    },
  };
}

export const carrierBillingAccountsHandler = {
  async create(request) {
    const context = idempotencyContext(request);
    if (context.error) return context.error;
    const parsed = await readJson(request);
    if (parsed.error) return parsed.error;
    const body = parsed.body;
    const prior = await findIdempotentEvent(request.env.DB, context.actor, context.key);
    if (prior) {
      return json({
        success: true,
        idempotent: true,
        account: await accountDetail(request.env.DB, prior.billing_account_id),
      });
    }

    if (body?.country_code !== 'SG'
      || body?.carrier !== 'Singtel'
      || body?.currency !== 'SGD'
      || typeof body?.display_name !== 'string'
      || !body.display_name.trim()
      || body.display_name.trim().length > 120
      || typeof body?.notification_sim_iccid !== 'string'
      || !/^\d{8}$/.test(body?.account_reference || '')) {
      return json({ error: 'Only a complete verified SG Singtel account is currently supported' }, 400);
    }
    const notificationSim = await request.env.DB.prepare(`
      SELECT iccid FROM device_view
      WHERE iccid = ? AND country = 'SG' AND carrier = 'Singtel'
        AND service_type = 'postpaid'
    `).bind(body.notification_sim_iccid).first();
    if (!notificationSim) {
      return json({ error: 'Notification SIM must be a verified SG Singtel postpaid SIM' }, 400);
    }

    const accountId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const digest = await sha256(body.account_reference);
    try {
      await request.env.DB.batch([
        request.env.DB.prepare(`
          INSERT INTO carrier_billing_accounts (
            id, country_code, carrier, currency, display_name,
            notification_sim_iccid, account_ref_digest, account_ref_last4,
            status, created_by
          ) VALUES (?, 'SG', 'Singtel', 'SGD', ?, ?, ?, ?,
            'pending_verification', ?)
        `).bind(
          accountId,
          body.display_name.trim(),
          body.notification_sim_iccid,
          digest,
          body.account_reference.slice(-4),
          context.actor,
        ),
        request.env.DB.prepare(`
          INSERT INTO carrier_billing_account_events (
            id, billing_account_id, event_type, actor_subject,
            idempotency_key, metadata_json
          ) VALUES (?, ?, 'created', ?, ?, ?)
        `).bind(eventId, accountId, context.actor, context.key, JSON.stringify({
          country_code: 'SG',
          carrier: 'Singtel',
          notification_sim_iccid: body.notification_sim_iccid,
        })),
      ]);
    } catch (error) {
      const raced = await findIdempotentEvent(request.env.DB, context.actor, context.key);
      if (raced) {
        return json({
          success: true,
          idempotent: true,
          account: await accountDetail(request.env.DB, raced.billing_account_id),
        });
      }
      if (String(error?.message || '').includes('UNIQUE')) {
        return json({ error: 'This carrier billing account already exists' }, 409);
      }
      throw error;
    }
    return json({ success: true, account: await accountDetail(request.env.DB, accountId) }, 201);
  },

  async previewMembers(request) {
    const parsed = await readJson(request);
    if (parsed.error) return parsed.error;
    const input = memberRequest(parsed.body);
    if (input.error) return json({ error: input.error }, 400);
    const preview = await buildMemberPreview(request.env.DB, request.params?.id, input);
    if (preview.response) return preview.response;
    return json({
      success: true,
      preview_digest: preview.preview_digest,
      summary: preview.summary,
      eligible: preview.eligible,
      ineligible: preview.ineligible,
      current_sim_iccids: preview.current,
    });
  },

  async applyMembers(request) {
    const context = idempotencyContext(request);
    if (context.error) return context.error;
    const parsed = await readJson(request);
    if (parsed.error) return parsed.error;
    const input = memberRequest(parsed.body);
    if (input.error) return json({ error: input.error }, 400);
    const accountId = request.params?.id;
    const prior = await findIdempotentEvent(request.env.DB, context.actor, context.key);
    if (prior) {
      if (prior.billing_account_id !== accountId) {
        return json({ error: 'Idempotency key was already used for another account' }, 409);
      }
      return json({
        success: true,
        idempotent: true,
        account: await accountDetail(request.env.DB, accountId),
      });
    }

    const preview = await buildMemberPreview(request.env.DB, accountId, input);
    if (preview.response) return preview.response;
    if (preview.ineligible.length > 0) {
      return json({ error: 'Membership preview contains ineligible SIMs', preview }, 400);
    }
    if (parsed.body.preview_digest !== preview.preview_digest) {
      return json({ error: 'Membership preview changed; run preview again' }, 409);
    }

    const mutationId = crypto.randomUUID();
    const desired = input.simIccids;
    const desiredSet = new Set(desired);
    const removed = preview.current.filter((iccid) => !desiredSet.has(iccid));
    const statements = [request.env.DB.prepare(`
      UPDATE carrier_billing_accounts
      SET version = version + 1,
          last_mutation_id = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND version = ?
    `).bind(mutationId, accountId, input.expectedVersion)];

    for (const iccid of removed) {
      statements.push(request.env.DB.prepare(`
        UPDATE carrier_billing_account_sims
        SET removed_at = CURRENT_TIMESTAMP
        WHERE billing_account_id = ? AND sim_iccid = ? AND removed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM carrier_billing_accounts
            WHERE id = ? AND last_mutation_id = ?
          )
      `).bind(accountId, iccid, accountId, mutationId));
    }
    for (const iccid of desired) {
      statements.push(request.env.DB.prepare(`
        INSERT INTO carrier_billing_account_sims (
          billing_account_id, sim_iccid, verification_source,
          verified_at, verified_by, removed_at
        )
        SELECT ?, ?, ?, CURRENT_TIMESTAMP, ?, NULL
        FROM carrier_billing_accounts
        WHERE id = ? AND last_mutation_id = ?
        ON CONFLICT(billing_account_id, sim_iccid) DO UPDATE SET
          verification_source = excluded.verification_source,
          verified_at = excluded.verified_at,
          verified_by = excluded.verified_by,
          removed_at = NULL
      `).bind(
        accountId,
        iccid,
        input.verificationSource,
        context.actor,
        accountId,
        mutationId,
      ));
    }
    statements.push(request.env.DB.prepare(`
      INSERT INTO carrier_billing_account_events (
        id, billing_account_id, event_type, actor_subject,
        idempotency_key, metadata_json
      )
      SELECT ?, ?, 'members_changed', ?, ?, ?
      FROM carrier_billing_accounts
      WHERE id = ? AND last_mutation_id = ?
    `).bind(
      crypto.randomUUID(),
      accountId,
      context.actor,
      context.key,
      JSON.stringify({
        desired_sim_iccids: desired,
        verification_source: input.verificationSource,
        added: preview.eligible.filter((sim) => !preview.current.includes(sim.iccid)).map((sim) => sim.iccid),
        removed,
      }),
      accountId,
      mutationId,
    ));

    const results = await request.env.DB.batch(statements);
    if (Number(results?.[0]?.meta?.changes ?? 0) !== 1) {
      const current = await accountDetail(request.env.DB, accountId);
      return json({ error: 'Billing account version conflict', current_version: current?.version }, 409);
    }
    return json({ success: true, account: await accountDetail(request.env.DB, accountId) });
  },

  async update(request) {
    const context = idempotencyContext(request);
    if (context.error) return context.error;
    const parsed = await readJson(request);
    if (parsed.error) return parsed.error;
    const accountId = request.params?.id;
    const expectedVersion = parsed.body?.expected_version;
    const status = parsed.body?.status;
    const displayName = parsed.body?.display_name;
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1
      || (status == null && displayName == null)
      || (status != null && !['pending_verification', 'active', 'inactive'].includes(status))
      || (displayName != null && (typeof displayName !== 'string'
        || !displayName.trim() || displayName.trim().length > 120))) {
      return json({ error: 'A valid expected_version and account update are required' }, 400);
    }
    const prior = await findIdempotentEvent(request.env.DB, context.actor, context.key);
    if (prior) {
      if (prior.billing_account_id !== accountId) {
        return json({ error: 'Idempotency key was already used for another account' }, 409);
      }
      return json({
        success: true,
        idempotent: true,
        account: await accountDetail(request.env.DB, accountId),
      });
    }
    const current = await accountDetail(request.env.DB, accountId);
    if (!current) return json({ error: 'Billing account not found' }, 404);
    if (current.version !== expectedVersion) {
      return json({ error: 'Billing account version conflict', current_version: current.version }, 409);
    }
    if (status === 'active'
      && !current.linked_sims.some((sim) => sim.iccid === current.notification_sim.iccid)) {
      return json({ error: 'Notification SIM must be a verified member before activation' }, 400);
    }

    const mutationId = crypto.randomUUID();
    const results = await request.env.DB.batch([
      request.env.DB.prepare(`
        UPDATE carrier_billing_accounts
        SET status = COALESCE(?, status),
            display_name = COALESCE(?, display_name),
            version = version + 1,
            last_mutation_id = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND version = ?
      `).bind(status ?? null, displayName?.trim() || null, mutationId, accountId, expectedVersion),
      request.env.DB.prepare(`
        INSERT INTO carrier_billing_account_events (
          id, billing_account_id, event_type, actor_subject,
          idempotency_key, metadata_json
        )
        SELECT ?, ?, 'updated', ?, ?, ?
        FROM carrier_billing_accounts
        WHERE id = ? AND last_mutation_id = ?
      `).bind(
        crypto.randomUUID(),
        accountId,
        context.actor,
        context.key,
        JSON.stringify({
          from_status: current.status,
          to_status: status ?? current.status,
          display_name_changed: displayName != null,
        }),
        accountId,
        mutationId,
      ),
    ]);
    if (Number(results?.[0]?.meta?.changes ?? 0) !== 1) {
      const latest = await accountDetail(request.env.DB, accountId);
      return json({ error: 'Billing account version conflict', current_version: latest?.version }, 409);
    }
    return json({ success: true, account: await accountDetail(request.env.DB, accountId) });
  },
};
