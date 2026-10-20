/* Versioned snapshots are read and written atomically by Postgres. */
(function () {
  const keys = ['transactions','credit_sales','budgets','categories','business_profile','gov_settings','stock_items','stock_movements','roles','workers','dispatches','log_trail'];
  function organization() {
    if (!window.activeOrganizationId || !window.sbClient) throw new Error('Sign in to an active company.');
    return window.activeOrganizationId;
  }
  window.makeSupabaseStorage = function () {
    const orgId = organization();
    let snapshot;
    let loading;
    let writing = Promise.resolve();
    function ensureCurrentOrg() { if (organization() !== orgId) throw new Error('Company session changed. Reload before continuing.'); }
    function accept(result) {
      if (result.error) throw new Error(result.error.message || 'The database could not save this operation.');
      if (!result.data?.data || !result.data?.versions) throw new Error('The database returned an incomplete response.');
      snapshot = result.data;
      return snapshot;
    }
    async function load(force = false) {
      ensureCurrentOrg();
      if (!force && snapshot) return snapshot;
      if (!loading) loading = window.sbClient.rpc('read_ledger_data', { p_org: orgId }).then(accept).finally(() => { loading = null; });
      return loading;
    }
    function serialize(task) {
      const current = writing.catch(() => {}).then(task);
      writing = current;
      return current;
    }
    return {
      load: async (force = false) => (await load(force)).data,
      get: async (key) => {
        if (!keys.includes(key)) throw new Error('Unsupported data collection.');
        const value = (await load()).data[key];
        return value == null ? null : { key, value: JSON.stringify(value), shared: false };
      },
      set: async (key, value) => serialize(async () => {
        ensureCurrentOrg();
        if (!keys.includes(key) || key === 'log_trail') throw new Error('Audit records are created by the database.');
        await load();
        const data = JSON.parse(value);
        const expected = { [key]: snapshot.versions[key] || 0 };
        accept(await window.sbClient.rpc('save_ledger_data', { p_org: orgId, p_expected: expected, p_changes: { [key]: data } }));
        return { key, value: JSON.stringify(snapshot.data[key]), shared: false };
      }),
      setMany: async (changes) => serialize(async () => {
        ensureCurrentOrg(); await load();
        if (!changes || Object.keys(changes).some(key => !keys.includes(key) || key === 'log_trail')) throw new Error('Unsupported data collection.');
        const expected = Object.fromEntries(Object.keys(changes).map(key => [key, snapshot.versions[key] || 0]));
        accept(await window.sbClient.rpc('save_ledger_data', { p_org: orgId, p_expected: expected, p_changes: changes }));
        return snapshot.data;
      }),
      action: async (action, input, requestId) => serialize(async () => {
        ensureCurrentOrg();
        await load();
        accept(await window.sbClient.rpc('perform_ledger_action', { p_org: orgId, p_action: action, p_input: input, p_expected: snapshot.versions, p_request_id: requestId }));
        return snapshot.data;
      }),
      delete: async function (key) { return this.set(key, JSON.stringify(['business_profile','gov_settings'].includes(key) ? {} : key === 'categories' ? {income:[],expense:[]} : [])); },
      list: async () => ({ keys }),
    };
  };
})();
