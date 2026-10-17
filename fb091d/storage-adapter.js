/* Supabase adapter retaining the window.storage get/set contract used by the UI. */
(function () {
  const versionByKey = new Map();
  const writeQueue = new Map();
  const tableByKey = {
    transactions: "transactions",
    credit_sales: "credit_sales",
    stock_items: "stock_items",
    stock_movements: "stock_movements",
    roles: "commission_roles",
    workers: "workers",
    dispatches: "dispatches",
    log_trail: "audit_events",
  };

  function parse(value) {
    try { return JSON.parse(value); } catch { throw new Error("Saved data is not valid JSON."); }
  }
  function fail(error) {
    if (error) throw new Error(error.message || "Database request failed.");
  }
  function getOrg() {
    if (!window.activeOrganizationId || !window.sbClient) throw new Error("Sign in to an active company to access its data.");
    return window.activeOrganizationId;
  }
  function idOf(item) { return String(item.id); }

  async function replaceRows(table, orgId, rows) {
    const existing = await window.sbClient.from(table).select("id").eq("organization_id", orgId);
    fail(existing.error);
    const incoming = new Set(rows.map((row) => String(row.id)));
    const removed = (existing.data || []).filter((row) => !incoming.has(String(row.id)));
    for (const row of removed) {
      const deleted = await window.sbClient.from(table).delete().eq("organization_id", orgId).eq("id", row.id);
      fail(deleted.error);
    }
    if (rows.length) {
      const saved = await window.sbClient.from(table).upsert(rows, { onConflict: "organization_id,id" });
      fail(saved.error);
    }
  }

  async function loadRows(table, orgId) {
    const result = await window.sbClient.from(table).select("*").eq("organization_id", orgId);
    fail(result.error);
    return result.data || [];
  }

  function recordRow(orgId, item, extra) {
    return { organization_id: orgId, id: idOf(item), payload: item, ...(extra || {}) };
  }

  async function setCollection(key, orgId, items) {
    if (key === "categories") {
      if (!items || typeof items !== "object" || Array.isArray(items)) throw new Error("Expected income and expense categories.");
      const rows = ["income", "expense"].flatMap((type) => (items[type] || []).map((item) => ({
        organization_id: orgId, id: String(item.id), category_type: type, label: String(item.label),
        cogs: type === "expense" && !!item.cogs, payload: item,
      })));
      const current = await loadRows("categories", orgId);
      const keep = new Set(rows.map((r) => r.id));
      for (const row of current.filter((r) => !keep.has(row.id))) {
        const deleted = await window.sbClient.from("categories").delete().eq("organization_id", orgId).eq("id", row.id);
        fail(deleted.error);
      }
      if (rows.length) {
        const saved = await window.sbClient.from("categories").upsert(rows, { onConflict: "organization_id,id" });
        fail(saved.error);
      }
      return;
    }

    if (!Array.isArray(items)) throw new Error("Expected a list of records.");

    if (key === "budgets") {
      const parents = items.map((item) => ({
        organization_id: orgId, id: idOf(item), title: String(item.title || "Budget"), created_at: item.createdAt || new Date().toISOString(),
        payload: Object.fromEntries(Object.entries(item).filter(([field]) => field !== "items")),
      }));
      const children = items.flatMap((budget) => (budget.items || []).map((item) => ({
        organization_id: orgId, id: idOf(item), budget_id: idOf(budget), category_id: String(item.category),
        amount_requested: Number(item.amountRequested), status: item.status, payload: item,
      })));
      const parentSave = await window.sbClient.from("budgets").upsert(parents, { onConflict: "organization_id,id" });
      fail(parentSave.error);
      await replaceRows("budget_items", orgId, children);
      await replaceRows("budgets", orgId, parents);
      return;
    }

    if (key === "credit_sales") {
      const rows = items.map((item) => ({
        organization_id: orgId, id: idOf(item), category_id: String(item.category), sale_date: item.date,
        amount: Number(item.amount), status: item.status === "paid" ? "paid" : "outstanding", payload: item,
      }));
      await replaceRows("credit_sales", orgId, rows);
      const payments = items.filter((item) => item.status === "paid").map((item) => ({
        organization_id: orgId, id: idOf(item), credit_sale_id: idOf(item), payment_date: item.paidDate || item.date,
        amount: Number(item.amount), payment_method: item.paidMethod || null,
        payload: { paidDate: item.paidDate || item.date, paidMethod: item.paidMethod || null },
      }));
      await replaceRows("credit_payments", orgId, payments);
      return;
    }

    if (key === "dispatches") {
      const rows = items.map((item) => ({
        organization_id: orgId, id: idOf(item), dispatch_date: item.date,
        status: item.status || "yet_to_deliver", product_amount: Number(item.productAmount || 0),
        delivery_amount: Number(item.deliveryAmount || 0), dispatcher_id: item.dispatcherId || null,
        bdo_id: item.bdoId || null, payload: item,
      }));
      await replaceRows("dispatches", orgId, rows);
      const remittances = items.filter((item) => item.vendorRemitStatus === "remitted").map((item) => ({
        organization_id: orgId, id: idOf(item), dispatch_id: idOf(item), payment_date: item.vendorRemitDate || item.date,
        amount: Number(item.vendorOwed), payment_method: item.vendorRemitMethod || null, payload: {},
      }));
      await replaceRows("vendor_remittances", orgId, remittances);
      const commissions = [];
      for (const item of items) {
        if (item.dispatcherCommissionPaid && item.dispatcherId && Number(item.dispatcherCommission) > 0) commissions.push({
          organization_id: orgId, id: `${item.id}:dispatcher`, worker_id: String(item.dispatcherId), payment_date: item.deliveredAt || item.date,
          amount: Number(item.dispatcherCommission), payment_method: null, payload: { dispatchId: item.id, role: "dispatcher" },
        });
        if (item.bdoCommissionPaid && item.bdoId && Number(item.bdoCommission) > 0) commissions.push({
          organization_id: orgId, id: `${item.id}:bdo`, worker_id: String(item.bdoId), payment_date: item.deliveredAt || item.date,
          amount: Number(item.bdoCommission), payment_method: null, payload: { dispatchId: item.id, role: "bdo" },
        });
      }
      await replaceRows("commission_payments", orgId, commissions);
      return;
    }

    if (key === "log_trail") {
      const current = await loadRows("audit_events", orgId);
      const known = new Set(current.map((row) => row.app_record_id));
      const additions = items.filter((item) => !known.has(String(item.id))).map((item) => ({
        organization_id: orgId, app_record_id: String(item.id), actor_user_id: window.activeUserId,
        action: String(item.action || "ledger_event"), entity_type: "ledger_event", entity_id: String(item.id),
        details: { detail: item.detail || "" }, payload: item, created_at: item.timestamp || new Date().toISOString(),
      }));
      if (additions.length) {
        const saved = await window.sbClient.from("audit_events").insert(additions);
        fail(saved.error);
      }
      return;
    }

    const table = tableByKey[key];
    if (!table) throw new Error(`Unsupported storage key: ${key}`);
    let rows;
    if (key === "transactions") rows = items.map((item) => recordRow(orgId, item, {
      date: item.date, transaction_type: item.type, category_id: String(item.category), amount: Number(item.amount),
      invoice_number: item.invoiceNo || null, invoice_issued_at: item.invoiceIssuedAt || null,
    }));
    else if (key === "stock_items") rows = items.map((item) => recordRow(orgId, item, { name: String(item.name), unit: String(item.unit || "units") }));
    else if (key === "stock_movements") rows = items.map((item) => recordRow(orgId, item, {
      item_id: String(item.itemId), movement_date: item.date, movement_type: item.type, quantity: Number(item.quantity),
    }));
    else if (key === "roles") rows = items.map((item) => recordRow(orgId, item, {
      name: String(item.name), commission_type: item.commissionType, rate: Number(item.rate || 0),
    }));
    else if (key === "workers") rows = items.map((item) => recordRow(orgId, item, {
      role_id: String(item.roleId), name: String(item.name), phone: item.phone || null,
    }));
    await replaceRows(table, orgId, rows);
  }

  async function getValue(key, orgId) {
    if (key === "business_profile" || key === "gov_settings") {
      const table = key === "business_profile" ? "business_profiles" : "org_settings";
      const result = await window.sbClient.from(table).select("payload").eq("organization_id", orgId).maybeSingle();
      fail(result.error);
      return result.data?.payload ?? null;
    }
    if (key === "categories") {
      const rows = await loadRows("categories", orgId);
      return { income: rows.filter((r) => r.category_type === "income").map((r) => r.payload), expense: rows.filter((r) => r.category_type === "expense").map((r) => r.payload) };
    }
    if (key === "budgets") {
      const [budgets, items] = await Promise.all([loadRows("budgets", orgId), loadRows("budget_items", orgId)]);
      return budgets.map((row) => ({ ...row.payload, items: items.filter((item) => item.budget_id === row.id).map((item) => item.payload) }));
    }
    if (key === "log_trail") {
      const result = await window.sbClient.from("audit_events").select("payload").eq("organization_id", orgId).not("app_record_id", "is", null).order("created_at", { ascending: false });
      fail(result.error);
      return (result.data || []).map((row) => row.payload);
    }
    const table = tableByKey[key];
    if (!table) throw new Error(`Unsupported storage key: ${key}`);
    const rows = await loadRows(table, orgId);
    return rows.map((row) => row.payload);
  }

  async function readVersion(key, orgId) {
    const result = await window.sbClient.from("org_data_versions").select("version")
      .eq("organization_id", orgId).eq("data_key", key).maybeSingle();
    fail(result.error);
    const version = Number(result.data?.version || 0);
    versionByKey.set(`${orgId}:${key}`, version);
    return version;
  }

  async function claimVersion(key, orgId) {
    const cacheKey = `${orgId}:${key}`;
    const expected = versionByKey.has(cacheKey) ? versionByKey.get(cacheKey) : await readVersion(key, orgId);
    const result = await window.sbClient.rpc("claim_org_data_version", {
      p_organization_id: orgId, p_data_key: key, p_expected_version: expected,
    });
    fail(result.error);
    if (result.data === null || result.data === undefined) {
      throw new Error("This data changed in another session. Reload the page before saving again.");
    }
    versionByKey.set(cacheKey, Number(result.data));
  }

  async function serializeWrite(key, task) {
    const previous = writeQueue.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    writeQueue.set(key, current);
    try { return await current; }
    finally { if (writeQueue.get(key) === current) writeQueue.delete(key); }
  }

  window.makeSupabaseStorage = function () {
    return {
      get: async function (key) {
        const orgId = getOrg();
        if (key !== "log_trail") await readVersion(key, orgId);
        const value = await getValue(key, orgId);
        return value === null ? null : { key, value: JSON.stringify(value), shared: false };
      },
      set: async function (key, value) {
        const orgId = getOrg();
        const data = parse(value);
        await serializeWrite(`${orgId}:${key}`, async () => {
          if (key !== "log_trail") await claimVersion(key, orgId);
          if (key === "business_profile" || key === "gov_settings") {
            const table = key === "business_profile" ? "business_profiles" : "org_settings";
            const saved = await window.sbClient.from(table).upsert({ organization_id: orgId, payload: data, updated_at: new Date().toISOString() }, { onConflict: "organization_id" });
            fail(saved.error);
          } else await setCollection(key, orgId, data);
        });
        return { key, value, shared: false };
      },
      delete: async function (key) {
        const orgId = getOrg();
        if (key === "business_profile" || key === "gov_settings") {
          const table = key === "business_profile" ? "business_profiles" : "org_settings";
          const result = await window.sbClient.from(table).delete().eq("organization_id", orgId);
          fail(result.error);
        } else if (key === "categories") await setCollection(key, orgId, { income: [], expense: [] });
        else await setCollection(key, orgId, []);
        return { key, deleted: true, shared: false };
      },
      list: async function () { return { keys: Object.keys(tableByKey).concat(["categories", "budgets", "business_profile", "gov_settings"]) }; },
    };
  };
})();
