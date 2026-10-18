import React, { useState, useEffect, useMemo, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@supabase/supabase-js";

window.supabase = { createClient };





const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');`;

const DEFAULT_CATEGORIES = {
  income: [
    { id: "booking_sales", label: "Booking Sales" },
    { id: "direct_sales", label: "Direct Sales" },
    { id: "coop_fees", label: "Cooperative / Franchise Fees" },
    { id: "other_income", label: "Other Income" },
  ],
  expense: [
    { id: "meat_purchase", label: "Goods / Materials Purchase", cogs: true },
    { id: "processing", label: "Processing & Packaging", cogs: true },
    { id: "logistics", label: "Logistics & Transport", cogs: false },
    { id: "salaries", label: "Salaries & Wages", cogs: false },
    { id: "rent_utilities", label: "Rent & Utilities", cogs: false },
    { id: "marketing", label: "Marketing & Outreach", cogs: false },
    { id: "admin", label: "Admin & Miscellaneous", cogs: false },
  ],
};

const PAYMENT_METHODS = ["Cash", "Bank Transfer", "POS", "Mobile Money"];

const naira = (n) =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(Math.round(n || 0));
const parseMoney = (value) => {
  const amount = Number.parseFloat(value);
  return Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * 100) / 100 : NaN;
};

const todayStr = () => new Date().toISOString().slice(0, 10);
const localDateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function slugify(label) {
  return (
    (label || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || `cat_${Date.now()}`
  );
}

function isCreditSettlement(t) {
  return !!t.creditId || String(t.description || "").startsWith("Credit payment —");
}

function categoryLabel(categories, type, id) {
  const list = (categories && categories[type]) || [];
  const found = list.find((c) => c.id === id);
  return found ? found.label : id;
}

function startOfWeek(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const diff = day === 0 ? -6 : 1 - day; // Monday start
  d.setDate(d.getDate() + diff);
  return d;
}

function fmtDate(d) {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function getPeriodRange(mode, anchorStr) {
  const anchor = new Date((anchorStr || "") + "T00:00:00");
  if (isNaN(anchor.getTime())) {
    const now = new Date();
    return getPeriodRange(mode, toDateStr(now));
  }
  if (mode === "day") {
    return { start: anchor, end: anchor, label: fmtDate(anchor) };
  }
  if (mode === "week") {
    const start = startOfWeek(anchorStr);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { start, end, label: `Week of ${fmtDate(start)} – ${fmtDate(end)}` };
  }
  if (mode === "year") {
    const start = new Date(anchor.getFullYear(), 0, 1);
    const end = new Date(anchor.getFullYear(), 11, 31);
    return { start, end, label: String(anchor.getFullYear()) };
  }
  // month (default)
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  return { start, end, label: start.toLocaleDateString("en-GB", { month: "long", year: "numeric" }) };
}

function MeatShareLedger({ orgName, appTitle, tagline, role = "viewer" } = {}) {
  const [businessProfile, setBusinessProfile] = useState({ name: "", phone: "", address: "", note: "" });
  const [profileDraft, setProfileDraft] = useState({ name: "", phone: "", address: "", note: "" });
  const [profileSaved, setProfileSaved] = useState(false);
  const displayName = (businessProfile.name || orgName || "SMART BOOK").trim();
  const brandEyebrow = displayName.toUpperCase();
  const brandTitle = appTitle || "The Ledger";
  const brandTagline = tagline || "Income · Expenses · Statements";
  const brandSlug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "smartbook";
  const [transactions, setTransactions] = useState([]);
  const [creditSales, setCreditSales] = useState([]);
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [newIncomeCat, setNewIncomeCat] = useState("");
  const [newExpenseCat, setNewExpenseCat] = useState("");
  const [newExpenseCatCogs, setNewExpenseCatCogs] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState("");
  const canManage = role === "owner" || role === "accountant";
  const canRecord = canManage || role === "staff";
  const requireManager = () => {
    if (canManage) return true;
    setSaveError("This action requires an organization owner or accountant.");
    return false;
  };
  const requireRecorder = () => {
    if (canRecord) return true;
    setSaveError("Your organization role is view-only.");
    return false;
  };
  const [tab, setTab] = useState("home");
  const [payingId, setPayingId] = useState(null);
  const [payDraft, setPayDraft] = useState({ date: todayStr(), method: "Cash" });
  const [creditView, setCreditView] = useState("outstanding");
  const [creditNote, setCreditNote] = useState("");

  // roles & commission (editable in Settings)
  const DEFAULT_ROLES = [
    { id: "dispatcher", name: "Dispatcher", commissionType: "flat", rate: 0 },
    { id: "bdo", name: "BDO", commissionType: "flat", rate: 0 },
  ];
  const [roles, setRoles] = useState(DEFAULT_ROLES);
  const [newRoleName, setNewRoleName] = useState("");

  // workers (dispatchers, BDOs, riders — anyone assigned a role and paid commission)
  const [workers, setWorkers] = useState([]);
  const [newWorkerName, setNewWorkerName] = useState("");
  const [newWorkerPhone, setNewWorkerPhone] = useState("");
  const [newWorkerRole, setNewWorkerRole] = useState("dispatcher");

  // dispatch book
  const [dispatches, setDispatches] = useState([]);
  const [dispatchForm, setDispatchForm] = useState({
    vendorName: "",
    merchantName: "",
    destination: "",
    unit: "",
    productName: "",
    productAmount: "",
    date: todayStr(),
    receiverPhone: "",
    dispatcherId: "",
    bdoId: "",
    deliveryAmount: "",
    chargeIncluded: true,
  });
  const [dispatchNote, setDispatchNote] = useState("");
  const [dispatchFilter, setDispatchFilter] = useState("all");
  const [remitDraft, setRemitDraft] = useState({ id: null, date: todayStr(), method: "Cash" });
  const [commissionPayDraft, setCommissionPayDraft] = useState({ workerId: null, date: todayStr(), method: "Cash" });

  const DELIVERY_STATUSES = [
    { id: "yet_to_deliver", label: "Yet to be Delivered" },
    { id: "on_transit", label: "On Transit" },
    { id: "delivered", label: "Delivered" },
    { id: "returned", label: "Returned" },
  ];

  // stock book
  const [stockItems, setStockItems] = useState([]);
  const [stockMovements, setStockMovements] = useState([]);
  const [selectedStockItem, setSelectedStockItem] = useState(null);
  const [newStockItemName, setNewStockItemName] = useState("");
  const [newStockItemUnit, setNewStockItemUnit] = useState("");
  const [stockMoveForm, setStockMoveForm] = useState({ date: todayStr(), type: "in", quantity: "", note: "", recordedBy: "" });

  const [creditForm, setCreditForm] = useState({
    customerName: "",
    date: todayStr(),
    category: DEFAULT_CATEGORIES.income[0].id,
    description: "",
    amount: "",
    dueDate: "",
  });

  // governance — budgets
  const [budgets, setBudgets] = useState([]);
  const [logTrail, setLogTrail] = useState([]);
  const [settings, setSettings] = useState({ approverPin: "", setupDone: false });
  const [pinSetupDraft, setPinSetupDraft] = useState("");
  const [budgetSubTab, setBudgetSubTab] = useState("new");

  const [budgetTitle, setBudgetTitle] = useState("");
  const [budgetAccountant, setBudgetAccountant] = useState("");
  const [budgetItemDraft, setBudgetItemDraft] = useState({ category: DEFAULT_CATEGORIES.expense[0].id, description: "", amount: "" });
  const [draftItems, setDraftItems] = useState([]);

  const [itemDecisionId, setItemDecisionId] = useState(null);
  const [itemDecisionDraft, setItemDecisionDraft] = useState({ pin: "", reason: "" });
  const [pinError, setPinError] = useState("");

  const [retireId, setRetireId] = useState(null);
  const [retireDraft, setRetireDraft] = useState({ date: todayStr(), amount: "", method: "Cash", note: "", recordedBy: "" });

  // form state
  const [form, setForm] = useState({
    date: todayStr(),
    type: "income",
    category: DEFAULT_CATEGORIES.income[0].id,
    description: "",
    amount: "",
    method: "Cash",
    requestedBy: "",
  });

  // salesbook state
  const [salesForm, setSalesForm] = useState({
    date: todayStr(),
    saleType: "cash",
    customerName: "",
    category: DEFAULT_CATEGORIES.income[0].id,
    description: "",
    amount: "",
    method: "Cash",
    dueDate: "",
    recordedBy: "",
  });

  // procurement
  const [procurementForm, setProcurementForm] = useState({
    date: todayStr(),
    supplier: "",
    category: DEFAULT_CATEGORIES.expense.find((c) => c.cogs)?.id || DEFAULT_CATEGORIES.expense[0].id,
    description: "",
    quantity: "",
    amount: "",
    method: "Cash",
    stockItemId: "",
    recordedBy: "",
  });

  // invoicing
  const [lastSale, setLastSale] = useState(null);
  const [recordType, setRecordType] = useState("sale");
  const [recordStockItemId, setRecordStockItemId] = useState("");
  const [stockSaved, setStockSaved] = useState("");
  const [showProcEntry, setShowProcEntry] = useState(false);
  const [showSalesEntry, setShowSalesEntry] = useState(false);
  const [showExpenseEntry, setShowExpenseEntry] = useState(false);
  const [expenseForm, setExpenseForm] = useState({
    date: todayStr(),
    category: "",
    description: "",
    amount: "",
    method: "Cash",
    recordedBy: "",
  });
  const [expenseSaved, setExpenseSaved] = useState("");
  const [invoiceView, setInvoiceView] = useState(null); // { sale, invoiceNo }
  const [invoicePhone, setInvoicePhone] = useState("");
  const [invoiceNote, setInvoiceNote] = useState("");
  const [invoiceImageUrl, setInvoiceImageUrl] = useState("");

  // ledger filters
  const [filterType, setFilterType] = useState("all");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");

  // ledger hub — sub-book + period
  const [ledgerSubTab, setLedgerSubTab] = useState("sales");
  const [ledgerPeriodMode, setLedgerPeriodMode] = useState("month");
  const [ledgerAnchor, setLedgerAnchor] = useState(todayStr());

  // report state
  const [periodMode, setPeriodMode] = useState("month"); // day | week | month | year
  const [monthValue, setMonthValue] = useState(todayStr().slice(0, 7));
  const [weekAnchor, setWeekAnchor] = useState(todayStr());
  const [reportDate, setReportDate] = useState(todayStr());
  const [reportYear, setReportYear] = useState(String(new Date().getFullYear()));

  useEffect(() => {
    (async () => {
      try {
        if (!window.storage) {
          setSaveError("Storage isn't available in this view — entries will only last for this session.");
          return;
        }
        const res = await window.storage.get("transactions", false);
        if (res && res.value) {
          setTransactions(JSON.parse(res.value));
        }
        try {
          const cres = await window.storage.get("credit_sales", false);
          if (cres && cres.value) setCreditSales(JSON.parse(cres.value));
        } catch (e2) {
          // no credit sales yet — fine
        }
        try {
          const bres = await window.storage.get("budgets", false);
          if (bres && bres.value) setBudgets(JSON.parse(bres.value));
        } catch (e3) {
          // none yet — fine
        }
        try {
          const lres = await window.storage.get("log_trail", false);
          if (lres && lres.value) setLogTrail(JSON.parse(lres.value));
        } catch (e5) {
          // none yet — fine
        }
        try {
          const sres = await window.storage.get("gov_settings", false);
          if (sres && sres.value) setSettings(JSON.parse(sres.value));
        } catch (e4) {
          // none yet — fine
        }
        try {
          const bpRes = await window.storage.get("business_profile", false);
          if (bpRes && bpRes.value) {
            const bp = JSON.parse(bpRes.value);
            setBusinessProfile(bp);
            setProfileDraft(bp);
          }
        } catch (e9) {
          // none yet — fine
        }
        try {
          const catRes = await window.storage.get("categories", false);
          if (catRes && catRes.value) {
            const loadedCats = JSON.parse(catRes.value);
            setCategories(loadedCats);
            const firstIncome = loadedCats.income[0]?.id;
            const firstExpense = loadedCats.expense[0]?.id;
            if (firstIncome) {
              setForm((f) => ({ ...f, category: f.type === "income" ? firstIncome : f.category }));
              setSalesForm((f) => ({ ...f, category: firstIncome }));
              setCreditForm((f) => ({ ...f, category: firstIncome }));
            }
            if (firstExpense) {
              setForm((f) => ({ ...f, category: f.type === "expense" ? firstExpense : f.category }));
              setBudgetItemDraft((d) => ({ ...d, category: firstExpense }));
            }
          }
        } catch (e6) {
          // none yet — fine, stays on defaults
        }
        try {
          const siRes = await window.storage.get("stock_items", false);
          if (siRes && siRes.value) setStockItems(JSON.parse(siRes.value));
        } catch (e7) {
          // none yet — fine
        }
        try {
          const smRes = await window.storage.get("stock_movements", false);
          if (smRes && smRes.value) setStockMovements(JSON.parse(smRes.value));
        } catch (e8) {
          // none yet — fine
        }
        try {
          const rRes = await window.storage.get("roles", false);
          if (rRes && rRes.value) setRoles(JSON.parse(rRes.value));
        } catch (e9) {
          // none yet — stays on defaults
        }
        try {
          const wRes = await window.storage.get("workers", false);
          if (wRes && wRes.value) setWorkers(JSON.parse(wRes.value));
        } catch (e10) {
          // none yet — fine
        }
        try {
          const dRes = await window.storage.get("dispatches", false);
          if (dRes && dRes.value) setDispatches(JSON.parse(dRes.value));
        } catch (e11) {
          // none yet — fine
        }
      } catch (e) {
        // no existing data yet, or key not found — fine, start empty
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const persist = useCallback(async (next) => {
    setTransactions(next);
    try {
      if (!window.storage) {
        setSaveError("Storage isn't available in this view — entries will only last for this session.");
        return;
      }
      const result = await window.storage.set("transactions", JSON.stringify(next), false);
      if (!result) {
        setSaveError("Save didn't confirm — entry is showing below but may not persist after refresh.");
      } else {
        setSaveError("");
      }
    } catch (e) {
      setSaveError(`Save failed (${e && e.message ? e.message : "unknown error"}) — entry is showing below but may not persist after refresh.`);
    }
  }, []);

  const persistCredit = useCallback(async (next) => {
    setCreditSales(next);
    try {
      if (!window.storage) return;
      const result = await window.storage.set("credit_sales", JSON.stringify(next), false);
      if (!result) {
        setSaveError("Save didn't confirm — entry is showing below but may not persist after refresh.");
      }
    } catch (e) {
      setSaveError(`Save failed (${e && e.message ? e.message : "unknown error"}) — entry is showing below but may not persist after refresh.`);
    }
  }, []);

  const persistCategories = useCallback(async (next) => {
    setCategories(next);
    try {
      if (!window.storage) return;
      await window.storage.set("categories", JSON.stringify(next), false);
    } catch (e) {
      setSaveError("Could not save category changes.");
    }
  }, []);

  const addIncomeCategory = () => {
    if (!requireManager()) return;
    if (!newIncomeCat.trim()) return;
    const id = slugify(newIncomeCat);
    if (categories.income.some((c) => c.id === id)) return;
    persistCategories({ ...categories, income: [...categories.income, { id, label: newIncomeCat.trim() }] });
    setNewIncomeCat("");
  };

  const addExpenseCategory = () => {
    if (!requireManager()) return;
    if (!newExpenseCat.trim()) return;
    const id = slugify(newExpenseCat);
    if (categories.expense.some((c) => c.id === id)) return;
    persistCategories({
      ...categories,
      expense: [...categories.expense, { id, label: newExpenseCat.trim(), cogs: newExpenseCatCogs }],
    });
    setNewExpenseCat("");
    setNewExpenseCatCogs(false);
  };

  const renameCategory = (type, id, newLabel) => {
    if (!requireManager()) return;
    persistCategories({
      ...categories,
      [type]: categories[type].map((c) => (c.id === id ? { ...c, label: newLabel } : c)),
    });
  };

  const toggleCategoryCogs = (id) => {
    if (!requireManager()) return;
    persistCategories({
      ...categories,
      expense: categories.expense.map((c) => (c.id === id ? { ...c, cogs: !c.cogs } : c)),
    });
  };

  const removeCategory = (type, id) => {
    if (!requireManager()) return;
    if (categories[type].length <= 1) return; // keep at least one category per type
    const referenced = type === "income"
      ? transactions.some((item) => item.category === id) || creditSales.some((item) => item.category === id) || budgets.some((budget) => budget.items.some((item) => item.category === id))
      : transactions.some((item) => item.category === id) || budgets.some((budget) => budget.items.some((item) => item.category === id));
    if (referenced) {
      setSaveError("This category is used by saved ledger or budget records. Rename it or move those records before removing it.");
      return;
    }
    if (!window.confirm(`Remove the ${categories[type].find((category) => category.id === id)?.label || "selected"} category?`)) return;
    persistCategories({ ...categories, [type]: categories[type].filter((c) => c.id !== id) });
    addLog("Category removed", `${categoryLabel(categories, type, id)} category removed from Settings`);
  };

  const persistStockItems = useCallback(async (next) => {
    setStockItems(next);
    try {
      if (!window.storage) return;
      await window.storage.set("stock_items", JSON.stringify(next), false);
    } catch (e) {
      setSaveError("Could not save stock item changes.");
    }
  }, []);

  const persistStockMovements = useCallback(async (next) => {
    setStockMovements(next);
    try {
      if (!window.storage) return;
      await window.storage.set("stock_movements", JSON.stringify(next), false);
    } catch (e) {
      setSaveError("Could not save stock movement.");
    }
  }, []);

  const persistRoles = useCallback(async (next) => {
    setRoles(next);
    try {
      if (!window.storage) return;
      await window.storage.set("roles", JSON.stringify(next), false);
    } catch (e) {
      setSaveError("Could not save commission settings.");
    }
  }, []);

  const persistWorkers = useCallback(async (next) => {
    setWorkers(next);
    try {
      if (!window.storage) return;
      await window.storage.set("workers", JSON.stringify(next), false);
    } catch (e) {
      setSaveError("Could not save worker changes.");
    }
  }, []);

  const persistDispatches = useCallback(async (next) => {
    setDispatches(next);
    try {
      if (!window.storage) return;
      await window.storage.set("dispatches", JSON.stringify(next), false);
    } catch (e) {
      setSaveError("Could not save delivery record.");
    }
  }, []);

  const addRole = () => {
    if (!requireManager()) return;
    if (!newRoleName.trim()) return;
    const id = slugify(newRoleName);
    if (roles.some((r) => r.id === id)) return;
    persistRoles([...roles, { id, name: newRoleName.trim(), commissionType: "flat", rate: 0 }]);
    setNewRoleName("");
  };

  const updateRole = (id, patch) => {
    if (!requireManager()) return;
    persistRoles(roles.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const removeRole = (id) => {
    if (!requireManager()) return;
    if (roles.length <= 1) return;
    if (workers.some((worker) => worker.roleId === id)) {
      setSaveError("This commission role is assigned to a worker. Reassign the worker before removing the role.");
      return;
    }
    if (!window.confirm(`Remove the ${roles.find((role) => role.id === id)?.name || "selected"} commission role?`)) return;
    persistRoles(roles.filter((r) => r.id !== id));
    addLog("Commission role removed", `${roles.find((role) => role.id === id)?.name || "Role"} removed from Settings`);
  };

  const addWorker = () => {
    if (!requireManager()) return;
    if (!newWorkerName.trim() || !newWorkerRole) return;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: newWorkerName.trim(),
      phone: newWorkerPhone.trim(),
      roleId: newWorkerRole,
    };
    persistWorkers([...workers, entry]);
    setNewWorkerName("");
    setNewWorkerPhone("");
  };

  const removeWorker = (id) => {
    if (!requireManager()) return;
    if (dispatches.some((dispatch) => dispatch.dispatcherId === id || dispatch.bdoId === id)) {
      setSaveError("This worker is linked to a delivery record. Keep the worker for reporting or reassign the deliveries before removing them.");
      return;
    }
    const worker = workers.find((item) => item.id === id);
    if (!window.confirm(`Remove ${worker?.name || "this worker"}?`)) return;
    persistWorkers(workers.filter((w) => w.id !== id));
    addLog("Worker removed", `${worker?.name || "Worker"} removed from Settings`);
  };

  const computeCommission = (roleId, deliveryAmount) => {
    const role = roles.find((r) => r.id === roleId);
    if (!role) return 0;
    const rate = parseFloat(role.rate) || 0;
    return role.commissionType === "percent" ? (deliveryAmount * rate) / 100 : rate;
  };

  const addStockItem = () => {
    if (!requireManager()) return;
    if (!newStockItemName.trim()) return;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: newStockItemName.trim(),
      unit: newStockItemUnit.trim() || "units",
      createdAt: new Date().toISOString(),
    };
    persistStockItems([...stockItems, entry]);
    addLog("Stock item added", `"${entry.name}" (${entry.unit}) added to Stock Book`);
    setNewStockItemName("");
    setNewStockItemUnit("");
  };

  const deleteStockItem = (id) => {
    if (!requireManager()) return;
    if (stockMovements.some((movement) => movement.itemId === id)) {
      setSaveError("This stock item has movement history. Keep it in Stock Book so past balances remain available.");
      return;
    }
    const item = stockItems.find((stockItem) => stockItem.id === id);
    if (!window.confirm(`Remove ${item?.name || "this stock item"}?`)) return;
    persistStockItems(stockItems.filter((s) => s.id !== id));
    persistStockMovements(stockMovements.filter((m) => m.itemId !== id));
    if (selectedStockItem === id) setSelectedStockItem(null);
    addLog("Stock item removed", `${item?.name || "Stock item"} removed from Stock Book`);
  };

  const addStockMovement = (idArg) => {
    if (!requireManager()) return;
    const targetId = typeof idArg === "string" ? idArg : selectedStockItem;
    const qty = parseFloat(stockMoveForm.quantity);
    if (!targetId || !stockMoveForm.date || !qty || qty <= 0) return;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      itemId: targetId,
      date: stockMoveForm.date,
      type: stockMoveForm.type,
      quantity: qty,
      note: stockMoveForm.note.trim(),
      recordedBy: stockMoveForm.recordedBy.trim(),
      createdAt: new Date().toISOString(),
    };
    persistStockMovements([...stockMovements, entry]);
    const item = stockItems.find((s) => s.id === targetId);
    addLog(
      "Stock movement recorded",
      `${entry.type === "in" ? "+" : "−"}${qty} ${item ? item.unit : ""} on "${item ? item.name : targetId}"${
        entry.note ? ` — ${entry.note}` : ""
      }`
    );
    setStockMoveForm((f) => ({ ...f, quantity: "", note: "" }));
    setStockSaved("✓ Stock movement recorded");
    setTimeout(() => setStockSaved(""), 3000);
  };

  const deleteStockMovement = (id) => {
    if (!requireManager()) return;
    const movement = stockMovements.find((item) => item.id === id);
    if (!movement || !window.confirm("Delete this stock movement? The recorded stock balance will change.")) return;
    persistStockMovements(stockMovements.filter((m) => m.id !== id));
    const item = stockItems.find((stockItem) => stockItem.id === movement.itemId);
    addLog("Stock movement deleted", `${movement.type} ${movement.quantity} ${item?.unit || "units"} ${item?.name || "stock item"} movement deleted`);
  };

  const recordDispatch = () => {
    if (!requireRecorder()) return;
    const productAmt = parseMoney(dispatchForm.productAmount) || 0;
    const deliveryAmt = parseMoney(dispatchForm.deliveryAmount);
    if (!dispatchForm.date || !deliveryAmt || deliveryAmt <= 0) return;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      vendorName: dispatchForm.vendorName.trim(),
      merchantName: dispatchForm.merchantName.trim(),
      destination: dispatchForm.destination.trim(),
      unit: dispatchForm.unit.trim(),
      productName: dispatchForm.productName.trim(),
      productAmount: productAmt,
      date: dispatchForm.date,
      receiverPhone: dispatchForm.receiverPhone.trim(),
      dispatcherId: dispatchForm.dispatcherId,
      bdoId: dispatchForm.bdoId,
      deliveryAmount: deliveryAmt,
      chargeIncluded: dispatchForm.chargeIncluded,
      status: "yet_to_deliver",
      deliveredAt: "",
      vendorOwed: 0,
      vendorRemitStatus: null,
      vendorRemitDate: "",
      vendorRemitMethod: "",
      dispatcherCommission: 0,
      dispatcherCommissionPaid: false,
      bdoCommission: 0,
      bdoCommissionPaid: false,
    };
    persistDispatches([entry, ...dispatches]);
    addLog("Delivery logged", `${entry.productName || "Delivery"} to ${entry.destination || "customer"} — ${naira(deliveryAmt)} service charge`);
    setDispatchNote(`✓ Delivery logged (₦${deliveryAmt.toLocaleString()} service charge)`);
    setTimeout(() => setDispatchNote(""), 3000);
    setDispatchForm((f) => ({
      ...f,
      vendorName: "",
      merchantName: "",
      destination: "",
      unit: "",
      productName: "",
      productAmount: "",
      receiverPhone: "",
      deliveryAmount: "",
    }));
  };

  const updateDispatchStatus = (id, newStatus) => {
    if (!requireManager()) return;
    const entry = dispatches.find((d) => d.id === id);
    if (!entry || entry.status === "delivered") return; // financial effects lock once delivered
    if (newStatus === "delivered") {
      const vendorOwed = entry.chargeIncluded ? Math.max(entry.productAmount - entry.deliveryAmount, 0) : entry.productAmount;
      const dispatcherCommission = entry.dispatcherId ? computeCommission(workers.find((w) => w.id === entry.dispatcherId)?.roleId, entry.deliveryAmount) : 0;
      const bdoCommission = entry.bdoId ? computeCommission(workers.find((w) => w.id === entry.bdoId)?.roleId, entry.deliveryAmount) : 0;

      const txEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        date: todayStr(),
        type: "income",
        category: categories.income[0]?.id || "",
        description: `Delivery service charge — ${entry.productName || entry.destination || "delivery"}${entry.vendorName ? " (" + entry.vendorName + ")" : ""}`,
        amount: entry.deliveryAmount,
        method: "Cash",
        requestedBy: "",
        dispatchId: entry.id,
      };
      persist([txEntry, ...transactions].sort((a, b) => (a.date < b.date ? 1 : -1)));

      const updated = {
        ...entry,
        status: "delivered",
        deliveredAt: todayStr(),
        vendorOwed,
        vendorRemitStatus: vendorOwed > 0 ? "pending" : "none",
        dispatcherCommission,
        bdoCommission,
      };
      persistDispatches(dispatches.map((d) => (d.id === id ? updated : d)));
      addLog(
        "Delivery completed",
        `${entry.productName || "Delivery"} marked delivered — ${naira(entry.deliveryAmount)} income recorded${
          vendorOwed > 0 ? `, ${naira(vendorOwed)} owed to ${entry.vendorName || "vendor"}` : ""
        }`
      );
    } else {
      persistDispatches(dispatches.map((d) => (d.id === id ? { ...d, status: newStatus } : d)));
    }
  };

  const confirmVendorRemit = () => {
    if (!requireManager()) return;
    const entry = dispatches.find((d) => d.id === remitDraft.id);
    if (!entry) return;
    persistDispatches(
      dispatches.map((d) =>
        d.id === entry.id
          ? { ...d, vendorRemitStatus: "remitted", vendorRemitDate: remitDraft.date, vendorRemitMethod: remitDraft.method }
          : d
      )
    );
    addLog("Vendor remitted", `${naira(entry.vendorOwed)} paid to ${entry.vendorName || "vendor"} for "${entry.productName || entry.destination}"`);
    setRemitDraft({ id: null, date: todayStr(), method: "Cash" });
  };

  const workerCommissionSummary = useMemo(() => {
    return workers.map((w) => {
      const asDispatcher = dispatches.filter((d) => d.dispatcherId === w.id && d.status === "delivered");
      const asBdo = dispatches.filter((d) => d.bdoId === w.id && d.status === "delivered");
      const earned =
        asDispatcher.reduce((s, d) => s + d.dispatcherCommission, 0) + asBdo.reduce((s, d) => s + d.bdoCommission, 0);
      const unpaid =
        asDispatcher.filter((d) => !d.dispatcherCommissionPaid).reduce((s, d) => s + d.dispatcherCommission, 0) +
        asBdo.filter((d) => !d.bdoCommissionPaid).reduce((s, d) => s + d.bdoCommission, 0);
      const role = roles.find((r) => r.id === w.roleId);
      return { worker: w, role, earned, unpaid, deliveries: asDispatcher.length + asBdo.length };
    });
  }, [workers, dispatches, roles]);

  const payWorkerCommission = (workerId) => {
    if (!requireManager()) return;
    const summary = workerCommissionSummary.find((s) => s.worker.id === workerId);
    if (!summary || summary.unpaid <= 0) return;
    const txEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      date: commissionPayDraft.date || todayStr(),
      type: "expense",
      category: categories.expense.find((c) => !c.cogs)?.id || categories.expense[0]?.id || "",
      description: `Commission paid — ${summary.worker.name} (${summary.role ? summary.role.name : ""})`,
      amount: summary.unpaid,
      method: commissionPayDraft.method || "Cash",
      requestedBy: "",
    };
    persist([txEntry, ...transactions].sort((a, b) => (a.date < b.date ? 1 : -1)));
    const nextDispatches = dispatches.map((d) => {
      let patch = {};
      if (d.dispatcherId === workerId && d.status === "delivered" && !d.dispatcherCommissionPaid) patch.dispatcherCommissionPaid = true;
      if (d.bdoId === workerId && d.status === "delivered" && !d.bdoCommissionPaid) patch.bdoCommissionPaid = true;
      return Object.keys(patch).length ? { ...d, ...patch } : d;
    });
    persistDispatches(nextDispatches);
    addLog("Commission paid", `${naira(summary.unpaid)} paid to ${summary.worker.name}`);
    setCommissionPayDraft({ workerId: null, date: todayStr(), method: "Cash" });
  };

  const totalHeldForVendors = useMemo(
    () => dispatches.filter((d) => d.vendorRemitStatus === "pending").reduce((s, d) => s + d.vendorOwed, 0),
    [dispatches]
  );

  const persistBudgets = useCallback(async (next) => {
    setBudgets(next);
    try {
      if (!window.storage) return;
      const result = await window.storage.set("budgets", JSON.stringify(next), false);
      if (!result) setSaveError("Save didn't confirm — entry is showing below but may not persist after refresh.");
    } catch (e) {
      setSaveError(`Save failed (${e && e.message ? e.message : "unknown error"}) — entry is showing below but may not persist after refresh.`);
    }
  }, []);

  const persistLog = useCallback(async (next) => {
    setLogTrail(next);
    try {
      if (!window.storage) return;
      await window.storage.set("log_trail", JSON.stringify(next), false);
    } catch (e) {
      // log trail is secondary — don't surface a save error banner for it
    }
  }, []);

  const addLog = useCallback(
    (action, detail) => {
      setLogTrail((prev) => {
        const next = [
          { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, timestamp: new Date().toISOString(), action, detail },
          ...prev,
        ];
        persistLog(next);
        return next;
      });
    },
    [persistLog]
  );

  const addTransaction = () => {
    if (form.type === "income" ? !requireRecorder() : !requireManager()) return;
    const amt = parseMoney(form.amount);
    if (!form.date || !amt || amt <= 0 || !form.category) return;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      date: form.date,
      type: form.type,
      category: form.category,
      description: form.description.trim(),
      amount: amt,
      method: form.method,
      requestedBy: form.requestedBy.trim(),
    };
    const next = [entry, ...transactions].sort((a, b) => (a.date < b.date ? 1 : -1));
    persist(next);
    setForm((f) => ({ ...f, description: "", amount: "" }));
  };

  const deleteTransaction = (id) => {
    if (!requireManager()) return;
    const transaction = transactions.find((item) => item.id === id);
    if (!transaction) return;
    if (transaction.creditId) {
      setSaveError("This income entry is linked to a credit settlement. Keep it to preserve the payment and report totals.");
      return;
    }
    if (!window.confirm(`Delete this ${transaction.type} entry for ${naira(transaction.amount)}?`)) return;
    persist(transactions.filter((t) => t.id !== id));
    addLog("Ledger entry deleted", `${transaction.type} ${naira(transaction.amount)} — ${transaction.description || categoryLabel(categories, transaction.type, transaction.category)}`);
  };

  const addCreditSale = () => {
    if (!requireRecorder()) return;
    const amt = parseMoney(creditForm.amount);
    if (!creditForm.customerName.trim() || !creditForm.date || !amt || amt <= 0) return;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      customerName: creditForm.customerName.trim(),
      date: creditForm.date,
      category: creditForm.category,
      description: creditForm.description.trim(),
      amount: amt,
      dueDate: creditForm.dueDate || "",
      status: "outstanding",
    };
    persistCredit([entry, ...creditSales]);
    setCreditForm((f) => ({ ...f, customerName: "", description: "", amount: "", dueDate: "" }));
  };

  const recordSale = () => {
    if (!requireRecorder()) return;
    const amt = parseMoney(salesForm.amount);
    if (!salesForm.date || !amt || amt <= 0 || !salesForm.category) return;

    if (salesForm.saleType === "credit") {
      if (!salesForm.customerName.trim()) return;
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        customerName: salesForm.customerName.trim(),
        date: salesForm.date,
        category: salesForm.category,
        description: salesForm.description.trim(),
        amount: amt,
        dueDate: salesForm.dueDate || "",
        status: "outstanding",
      };
      persistCredit([entry, ...creditSales]);
      addLog(
        "Credit sale recorded",
        `${naira(amt)} sale to ${entry.customerName} logged as credit via Salesbook${entry.description ? ` — ${entry.description}` : ""}`
      );
      setLastSale({
        date: entry.date,
        customerName: entry.customerName,
        category: entry.category,
        description: entry.description,
        amount: entry.amount,
        source: "Credit",
        method: "",
        dueDate: entry.dueDate,
      });
    } else {
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        date: salesForm.date,
        type: "income",
        category: salesForm.category,
        description: salesForm.customerName.trim()
          ? `${salesForm.description.trim() ? salesForm.description.trim() + " — " : ""}${salesForm.customerName.trim()}`
          : salesForm.description.trim(),
        amount: amt,
        method: salesForm.method,
        requestedBy: salesForm.recordedBy.trim(),
      };
      const next = [entry, ...transactions].sort((a, b) => (a.date < b.date ? 1 : -1));
      persist(next);
      setLastSale({
        date: entry.date,
        customerName: salesForm.customerName.trim(),
        category: entry.category,
        description: salesForm.description.trim(),
        amount: entry.amount,
        source: "Cash",
        method: entry.method,
        dueDate: "",
      });
    }

    setSalesForm((f) => ({ ...f, customerName: "", description: "", amount: "", dueDate: "" }));
  };

  const recordProcurement = () => {
    if (!requireManager()) return;
    const amt = parseMoney(procurementForm.amount);
    if (!procurementForm.date || !amt || amt <= 0 || !procurementForm.category) return;

    const desc = [procurementForm.supplier.trim(), procurementForm.description.trim()].filter(Boolean).join(" — ");
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      date: procurementForm.date,
      type: "expense",
      category: procurementForm.category,
      description: desc,
      amount: amt,
      method: procurementForm.method,
      requestedBy: procurementForm.recordedBy.trim(),
    };
    const nextTx = [entry, ...transactions].sort((a, b) => (a.date < b.date ? 1 : -1));
    persist(nextTx);

    let stockNote = "";
    const qty = parseFloat(procurementForm.quantity);
    if (procurementForm.stockItemId && qty && qty > 0) {
      const item = stockItems.find((s) => s.id === procurementForm.stockItemId);
      if (item) {
        const movement = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          itemId: item.id,
          date: procurementForm.date,
          type: "in",
          quantity: qty,
          note: `Procurement${procurementForm.supplier.trim() ? ` from ${procurementForm.supplier.trim()}` : ""}`,
          recordedBy: procurementForm.recordedBy.trim(),
          createdAt: new Date().toISOString(),
        };
        persistStockMovements([...stockMovements, movement]);
        stockNote = ` and ${qty} ${item.unit} added to ${item.name} stock`;
      }
    }

    addLog(
      "Procurement recorded",
      `${naira(amt)} procurement${procurementForm.supplier.trim() ? ` from ${procurementForm.supplier.trim()}` : ""}${
        procurementForm.description.trim() ? ` — ${procurementForm.description.trim()}` : ""
      }${stockNote}`
    );

    setProcurementForm((f) => ({ ...f, supplier: "", description: "", quantity: "", amount: "", stockItemId: "" }));
  };

  const startPayment = (id) => {
    setPayingId(id);
    setPayDraft({ date: todayStr(), method: "Cash" });
  };

  const confirmPayment = (entry) => {
    if (!requireManager()) return;
    const txEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      date: payDraft.date,
      type: "income",
      category: entry.category,
      description: `Credit payment — ${entry.customerName}${entry.description ? " (" + entry.description + ")" : ""}`,
      amount: entry.amount,
      method: payDraft.method,
      creditId: entry.id,
    };
    const nextTx = [txEntry, ...transactions].sort((a, b) => (a.date < b.date ? 1 : -1));
    persist(nextTx);
    const nextCredit = creditSales.map((c) =>
      c.id === entry.id ? { ...c, status: "paid", paidDate: payDraft.date, paidMethod: payDraft.method } : c
    );
    persistCredit(nextCredit);
    setPayingId(null);
    setCreditNote(`✓ ${naira(entry.amount)} from ${entry.customerName} marked paid and added to Money In (Cash Ledger).`);
    setTimeout(() => setCreditNote(""), 6000);
  };

  const deleteCreditSale = (id) => {
    if (!requireManager()) return;
    const creditSale = creditSales.find((item) => item.id === id);
    if (!creditSale) return;
    if (creditSale.status === "paid") {
      setSaveError("This credit sale has been settled. Keep it so its payment remains linked to the ledger.");
      return;
    }
    if (!window.confirm(`Delete the outstanding credit sale for ${creditSale.customerName} (${naira(creditSale.amount)})?`)) return;
    persistCredit(creditSales.filter((c) => c.id !== id));
    addLog("Credit sale deleted", `${naira(creditSale.amount)} outstanding sale for ${creditSale.customerName} deleted`);
  };

  const savePin = () => {
    if (!requireManager()) return;
    if (!pinSetupDraft.trim()) return;
    const next = { approverPin: pinSetupDraft.trim(), setupDone: true };
    setSettings(next);
    (async () => {
      try {
        if (window.storage) await window.storage.set("gov_settings", JSON.stringify(next), false);
      } catch (e) {
        setSaveError("Could not save approver PIN.");
      }
    })();
    setPinSetupDraft("");
  };

  const addDraftItem = () => {
    const amt = parseMoney(budgetItemDraft.amount);
    if (!budgetItemDraft.description.trim() || !amt || amt <= 0) return;
    setDraftItems((items) => [
      ...items,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        category: budgetItemDraft.category,
        description: budgetItemDraft.description.trim(),
        amountRequested: amt,
        status: "pending",
        retirements: [],
      },
    ]);
    setBudgetItemDraft((d) => ({ ...d, description: "", amount: "" }));
  };

  const removeDraftItem = (id) => setDraftItems((items) => items.filter((i) => i.id !== id));

  const submitBudget = () => {
    if (!requireManager()) return;
    if (!budgetTitle.trim() || draftItems.length === 0) return;
    const budget = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: budgetTitle.trim(),
      accountant: budgetAccountant.trim(),
      createdAt: new Date().toISOString(),
      items: draftItems,
    };
    const next = [budget, ...budgets];
    persistBudgets(next);
    const total = draftItems.reduce((s, i) => s + i.amountRequested, 0);
    addLog(
      "Budget submitted",
      `"${budget.title}" submitted by ${budget.accountant || "accountant"} — ${draftItems.length} item(s) totaling ${naira(total)}`
    );
    setBudgetTitle("");
    setBudgetAccountant("");
    setDraftItems([]);
    setBudgetSubTab("review");
  };

  const startItemDecision = (budgetId, itemId) => {
    setItemDecisionId(`${budgetId}::${itemId}`);
    setItemDecisionDraft({ pin: "", reason: "" });
    setPinError("");
  };

  const decideItem = (budget, item, decision) => {
    if (!requireManager()) return;
    if (itemDecisionDraft.pin.trim() !== (settings.approverPin || "").trim()) {
      setPinError("PIN doesn't match. Ask the approver to confirm and try again.");
      return;
    }
    if (decision === "rejected" && !itemDecisionDraft.reason.trim()) {
      setPinError("A reason is required to reject an item.");
      return;
    }
    const nextBudgets = budgets.map((b) =>
      b.id !== budget.id
        ? b
        : {
            ...b,
            items: b.items.map((i) =>
              i.id !== item.id
                ? i
                : {
                    ...i,
                    status: decision,
                    decidedAt: new Date().toISOString(),
                    rejectReason: decision === "rejected" ? itemDecisionDraft.reason.trim() : "",
                  }
            ),
          }
    );
    persistBudgets(nextBudgets);
    addLog(
      decision === "approved" ? "Item approved" : "Item rejected",
      `"${item.description}" (${naira(item.amountRequested)}) in budget "${budget.title}"${
        decision === "rejected" ? ` — reason: ${itemDecisionDraft.reason.trim()}` : ""
      }`
    );
    setItemDecisionId(null);
    setPinError("");
  };

  const startRetire = (budgetId, itemId, remaining) => {
    setRetireId(`${budgetId}::${itemId}`);
    setRetireDraft({ date: todayStr(), amount: String(remaining), method: "Cash", note: "", recordedBy: "" });
  };

  const retirePayment = (budget, item) => {
    if (!requireManager()) return;
    const amt = parseMoney(retireDraft.amount);
    const retiredSoFar = item.retirements.reduce((s, r) => s + r.amount, 0);
    const remaining = item.amountRequested - retiredSoFar;
    if (!amt || amt <= 0) return;
    if (amt > remaining + 0.01 && !retireDraft.note.trim()) {
      setPinError(
        `This is ₦${(amt - remaining).toLocaleString()} more than the ₦${remaining.toLocaleString()} remaining on this item — add a note explaining the overspend to continue.`
      );
      return;
    }
    const retirement = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      date: retireDraft.date,
      amount: amt,
      method: retireDraft.method,
      note: retireDraft.note.trim(),
      recordedBy: retireDraft.recordedBy.trim(),
      recordedAt: new Date().toISOString(),
    };
    const txEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      date: retireDraft.date,
      type: "expense",
      category: item.category,
      description: `Budget retirement — ${budget.title}: ${item.description}`,
      amount: amt,
      method: retireDraft.method,
      requestedBy: retireDraft.recordedBy.trim(),
    };
    const nextTx = [txEntry, ...transactions].sort((a, b) => (a.date < b.date ? 1 : -1));
    persist(nextTx);

    const nextBudgets = budgets.map((b) =>
      b.id !== budget.id
        ? b
        : {
            ...b,
            items: b.items.map((i) => (i.id !== item.id ? i : { ...i, retirements: [...i.retirements, retirement] })),
          }
    );
    persistBudgets(nextBudgets);
    addLog(
      "Payment retired",
      `${naira(amt)} retired against "${item.description}" in budget "${budget.title}" by ${
        retireDraft.recordedBy.trim() || "accountant"
      }. Ledger entry created.`
    );
    setRetireId(null);
    setPinError("");
  };

  const exportBackup = () => {
    try {
      const blob = new Blob(
        [JSON.stringify({ transactions, creditSales, budgets, logTrail, settings, categories, stockItems, stockMovements, businessProfile, dispatches, roles, workers }, null, 2)],
        { type: "application/json" }
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${brandSlug}-ledger-${todayStr()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setSaveError("Could not export backup file.");
    }
  };

  const importBackup = (e) => {
    if (!requireManager()) return;
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (Array.isArray(data)) {
          persist(data);
        } else if (data && Array.isArray(data.transactions)) {
          persist(data.transactions);
          if (Array.isArray(data.creditSales)) persistCredit(data.creditSales);
          if (Array.isArray(data.budgets)) persistBudgets(data.budgets);
          if (Array.isArray(data.logTrail)) persistLog(data.logTrail);
          if (data.categories) persistCategories(data.categories);
          if (data.businessProfile) {
            setBusinessProfile(data.businessProfile);
            setProfileDraft(data.businessProfile);
            if (window.storage) window.storage.set("business_profile", JSON.stringify(data.businessProfile), false).catch(() => {});
          }
          if (Array.isArray(data.stockItems)) persistStockItems(data.stockItems);
          if (Array.isArray(data.stockMovements)) persistStockMovements(data.stockMovements);
          if (Array.isArray(data.dispatches)) persistDispatches(data.dispatches);
          if (Array.isArray(data.roles)) persistRoles(data.roles);
          if (Array.isArray(data.workers)) persistWorkers(data.workers);
          if (data.settings) {
            setSettings(data.settings);
            if (window.storage) window.storage.set("gov_settings", JSON.stringify(data.settings), false).catch(() => {});
          }
        } else {
          setSaveError("That file doesn't look like a ledger backup.");
          return;
        }
        setSaveError("");
      } catch (err) {
        setSaveError("Could not read that file — make sure it's a ledger backup exported from this app.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const totals = useMemo(() => {
    const income = transactions.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
    const expense = transactions.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
    return { income, expense, balance: income - expense };
  }, [transactions]);

  const stockBalances = useMemo(() => {
    const map = {};
    stockItems.forEach((s) => {
      map[s.id] = 0;
    });
    stockMovements.forEach((m) => {
      if (!(m.itemId in map)) map[m.itemId] = 0;
      map[m.itemId] += m.type === "in" ? m.quantity : -m.quantity;
    });
    return map;
  }, [stockItems, stockMovements]);

  const selectedStockMovements = useMemo(() => {
    if (!selectedStockItem) return [];
    const rows = stockMovements
      .filter((m) => m.itemId === selectedStockItem)
      .sort((a, b) => (a.date === b.date ? a.createdAt.localeCompare(b.createdAt) : a.date < b.date ? -1 : 1));
    let running = 0;
    return rows.map((m) => {
      running += m.type === "in" ? m.quantity : -m.quantity;
      return { ...m, balance: running };
    });
  }, [stockMovements, selectedStockItem]);

  const outstandingTotal = useMemo(
    () => creditSales.filter((c) => c.status === "outstanding").reduce((s, c) => s + c.amount, 0),
    [creditSales]
  );

  const pendingList = useMemo(() => {
    const out = [];
    budgets.forEach((b) => b.items.forEach((i) => i.status === "pending" && out.push({ budget: b, item: i })));
    return out;
  }, [budgets]);
  const pendingTotal = useMemo(() => pendingList.reduce((s, p) => s + p.item.amountRequested, 0), [pendingList]);

  const approvedAwaitingRetire = useMemo(() => {
    const out = [];
    budgets.forEach((b) =>
      b.items.forEach((i) => {
        if (i.status !== "approved") return;
        const retired = i.retirements.reduce((s, r) => s + r.amount, 0);
        if (retired < i.amountRequested - 0.01) out.push({ budget: b, item: i, retired, remaining: i.amountRequested - retired });
      })
    );
    return out;
  }, [budgets]);

  const filteredLedger = useMemo(() => {
    return transactions.filter((t) => {
      if (filterType !== "all" && t.type !== filterType) return false;
      if (filterFrom && t.date < filterFrom) return false;
      if (filterTo && t.date > filterTo) return false;
      return true;
    });
  }, [transactions, filterType, filterFrom, filterTo]);

  const ledgerRange = useMemo(() => getPeriodRange(ledgerPeriodMode, ledgerAnchor), [ledgerPeriodMode, ledgerAnchor]);
  const ledgerRangeStrs = useMemo(
    () => ({ start: toDateStr(ledgerRange.start), end: toDateStr(ledgerRange.end) }),
    [ledgerRange]
  );

  const applyLedgerPreset = () => {
    setFilterFrom(ledgerRangeStrs.start);
    setFilterTo(ledgerRangeStrs.end);
  };

  const salesLedgerRows = useMemo(() => {
    const cashRows = transactions
      .filter((t) => t.type === "income" && !isCreditSettlement(t) && t.date >= ledgerRangeStrs.start && t.date <= ledgerRangeStrs.end)
      .map((t) => ({
        id: `cash-${t.id}`,
        date: t.date,
        source: "Cash",
        category: categoryLabel(categories, "income", t.category),
        description: t.description,
        amount: t.amount,
        status: "Collected",
        raw: { date: t.date, customerName: "", category: t.category, description: t.description, amount: t.amount, source: "Cash", method: t.method, dueDate: "" },
      }));
    const creditRows = creditSales
      .filter((c) => c.date >= ledgerRangeStrs.start && c.date <= ledgerRangeStrs.end)
      .map((c) => ({
        id: `credit-${c.id}`,
        date: c.date,
        source: "Credit",
        category: `${categoryLabel(categories, "income", c.category)} — ${c.customerName}`,
        description: c.description,
        amount: c.amount,
        status: c.status === "paid" ? "Paid" : "Outstanding",
        raw: { date: c.date, customerName: c.customerName, category: c.category, description: c.description, amount: c.amount, source: "Credit", method: c.paidMethod || "", dueDate: c.dueDate || "", status: c.status },
      }));
    return [...cashRows, ...creditRows].sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [transactions, creditSales, ledgerRangeStrs]);

  const salesLedgerTotals = useMemo(() => {
    const cash = salesLedgerRows.filter((r) => r.source === "Cash").reduce((s, r) => s + r.amount, 0);
    const credit = salesLedgerRows.filter((r) => r.source === "Credit").reduce((s, r) => s + r.amount, 0);
    return { cash, credit, total: cash + credit };
  }, [salesLedgerRows]);

  const expenseLedgerRows = useMemo(() => {
    return transactions
      .filter((t) => t.type === "expense" && t.date >= ledgerRangeStrs.start && t.date <= ledgerRangeStrs.end)
      .map((t) => ({
        id: t.id,
        date: t.date,
        category: categoryLabel(categories, "expense", t.category),
        description: t.description,
        amount: t.amount,
        method: t.method,
        isProcurement: !!categories.expense.find((c) => c.id === t.category)?.cogs,
      }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [transactions, categories, ledgerRangeStrs]);

  const expenseLedgerTotal = useMemo(() => expenseLedgerRows.reduce((s, r) => s + r.amount, 0), [expenseLedgerRows]);

  const procurementLedgerRows = useMemo(() => expenseLedgerRows.filter((r) => r.isProcurement), [expenseLedgerRows]);
  const procurementLedgerTotal = useMemo(() => procurementLedgerRows.reduce((s, r) => s + r.amount, 0), [procurementLedgerRows]);

  const creditLedgerRows = useMemo(
    () => creditSales.filter((c) => c.date >= ledgerRangeStrs.start && c.date <= ledgerRangeStrs.end).sort((a, b) => (a.date < b.date ? 1 : -1)),
    [creditSales, ledgerRangeStrs]
  );

  const creditLedgerTotals = useMemo(() => {
    const total = creditLedgerRows.reduce((s, c) => s + c.amount, 0);
    const outstanding = creditLedgerRows.filter((c) => c.status === "outstanding").reduce((s, c) => s + c.amount, 0);
    const paid = total - outstanding;
    return { total, outstanding, paid };
  }, [creditLedgerRows]);

  const budgetLedgerRows = useMemo(() => {
    const rows = [];
    budgets.forEach((b) => {
      const bDate = b.createdAt.slice(0, 10);
      if (bDate < ledgerRangeStrs.start || bDate > ledgerRangeStrs.end) return;
      b.items.forEach((i) => {
        const retired = i.retirements.reduce((s, r) => s + r.amount, 0);
        rows.push({
          id: `${b.id}-${i.id}`,
          date: bDate,
          budgetTitle: b.title,
          category: categoryLabel(categories, "expense", i.category),
          description: i.description,
          requested: i.amountRequested,
          status: i.status,
          retired,
        });
      });
    });
    return rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [budgets, ledgerRangeStrs]);

  const budgetLedgerTotals = useMemo(() => {
    const requested = budgetLedgerRows.reduce((s, r) => s + r.requested, 0);
    const approved = budgetLedgerRows.filter((r) => r.status === "approved").reduce((s, r) => s + r.requested, 0);
    const retired = budgetLedgerRows.reduce((s, r) => s + r.retired, 0);
    return { requested, approved, retired };
  }, [budgetLedgerRows]);

  const reportRange = useMemo(() => {
    if (periodMode === "day") {
      const start = new Date(`${reportDate}T00:00:00`);
      return { start, end: new Date(start), label: start.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" }) };
    }
    if (periodMode === "week") {
      const start = startOfWeek(weekAnchor);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      return { start, end, label: `Week of ${fmtDate(start)} – ${fmtDate(end)}` };
    }
    if (periodMode === "year") {
      const year = Number(reportYear);
      return { start: new Date(year, 0, 1), end: new Date(year, 11, 31), label: String(year) };
    }
    const [y, m] = monthValue.split("-").map(Number);
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0);
    return {
      start,
      end,
      label: start.toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
    };
  }, [periodMode, weekAnchor, monthValue, reportDate, reportYear]);

  const reportTx = useMemo(() => {
    const startStr = localDateKey(reportRange.start);
    const endStr = localDateKey(reportRange.end);
    return transactions.filter((t) => t.date >= startStr && t.date <= endStr);
  }, [transactions, reportRange]);

  const statement = useMemo(() => {
    const salesCats = ["booking_sales", "direct_sales"];
    const sales = reportTx
      .filter((t) => t.type === "income" && salesCats.includes(t.category))
      .reduce((s, t) => s + t.amount, 0);
    const otherIncome = reportTx
      .filter((t) => t.type === "income" && !salesCats.includes(t.category))
      .reduce((s, t) => s + t.amount, 0);

    const cogsLines = categories.expense.filter((c) => c.cogs);
    const opexLines = categories.expense.filter((c) => !c.cogs);

    const cogsByCategory = cogsLines.map((c) => ({
      ...c,
      amount: reportTx.filter((t) => t.type === "expense" && t.category === c.id).reduce((s, t) => s + t.amount, 0),
    }));
    const opexByCategory = opexLines.map((c) => ({
      ...c,
      amount: reportTx.filter((t) => t.type === "expense" && t.category === c.id).reduce((s, t) => s + t.amount, 0),
    }));

    const totalCogs = cogsByCategory.reduce((s, c) => s + c.amount, 0);
    const grossProfit = sales - totalCogs;
    const totalOpex = opexByCategory.reduce((s, c) => s + c.amount, 0);
    const netProfit = grossProfit + otherIncome - totalOpex;

    return { sales, totalCogs, cogsByCategory, grossProfit, otherIncome, opexByCategory, totalOpex, netProfit };
  }, [reportTx]);

  const investorTrend = useMemo(() => {
    const weeks = [];
    for (let i = 7; i >= 0; i--) {
      const anchor = new Date();
      anchor.setDate(anchor.getDate() - i * 7);
      const start = startOfWeek(anchor.toISOString().slice(0, 10));
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      const sStr = start.toISOString().slice(0, 10);
      const eStr = end.toISOString().slice(0, 10);
      const tx = transactions.filter((t) => t.date >= sStr && t.date <= eStr);
      const sales = tx.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
      const expenses = tx.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
      weeks.push({ label: fmtDate(start), sales, expenses, profit: sales - expenses });
    }

    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      const sStr = start.toISOString().slice(0, 10);
      const eStr = end.toISOString().slice(0, 10);
      const tx = transactions.filter((t) => t.date >= sStr && t.date <= eStr);
      const sales = tx.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
      const expenses = tx.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
      months.push({ label: start.toLocaleDateString("en-GB", { month: "short", year: "2-digit" }), sales, expenses, profit: sales - expenses });
    }

    return { weeks, months };
  }, [transactions]);

  const generateInvestorSnapshot = () => {
    const thisWeek = investorTrend.weeks[investorTrend.weeks.length - 1];
    const thisMonth = investorTrend.months[investorTrend.months.length - 1];
    const maxWeekVal = Math.max(1, ...investorTrend.weeks.map((w) => Math.max(w.sales, w.expenses)));
    const maxMonthVal = Math.max(1, ...investorTrend.months.map((m) => Math.max(m.sales, m.expenses)));

    const barRow = (label, sales, expenses, profit, maxVal) => `
      <div style="margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;font-size:12px;color:#7A7566;margin-bottom:4px;">
          <span>${label}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-weight:700;color:${profit >= 0 ? "#2F5233" : "#A6491E"};">${naira(profit)}</span>
        </div>
        <div style="background:#EFEBE0;border-radius:4px;height:8px;overflow:hidden;margin-bottom:2px;">
          <div style="background:#2F5233;height:100%;width:${(sales / maxVal) * 100}%;"></div>
        </div>
        <div style="background:#EFEBE0;border-radius:4px;height:8px;overflow:hidden;">
          <div style="background:#A6491E;height:100%;width:${(expenses / maxVal) * 100}%;"></div>
        </div>
      </div>`;

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<title>${brandEyebrow} — Investor Snapshot</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600;700&display=swap');
body { margin:0; padding:20px 16px 60px; background:#F6F3EC; color:#21281F; font-family:'Inter',sans-serif; }
.wrap { max-width: 640px; margin: 0 auto; }
.masthead { text-align:center; border-bottom:2px solid #21281F; padding-bottom:18px; margin-bottom:22px; }
.eyebrow { font-size:11px; letter-spacing:0.18em; color:#C9A227; font-weight:700; }
h1 { font-family:'Fraunces',serif; font-size:30px; margin:2px 0 4px; }
.sub { font-size:12px; color:#7A7566; }
.cards { display:flex; gap:12px; margin-bottom:28px; flex-wrap:wrap; }
.card { flex:1; min-width:150px; background:#fff; border:1px solid #D8D2C2; border-radius:10px; padding:14px; }
.card .l { font-size:11px; color:#7A7566; text-transform:uppercase; letter-spacing:0.05em; }
.card .v { font-family:'IBM Plex Mono',monospace; font-size:20px; font-weight:700; margin-top:4px; }
.section-title { font-size:12px; letter-spacing:0.1em; text-transform:uppercase; color:#C9A227; font-weight:700; margin:24px 0 12px; border-bottom:1px solid #D8D2C2; padding-bottom:6px; }
.legend { font-size:11px; color:#7A7566; margin-bottom:10px; }
.legend span { display:inline-flex; align-items:center; gap:5px; margin-right:14px; }
.dot { width:8px; height:8px; border-radius:2px; display:inline-block; }
.footer { font-size:11px; color:#7A7566; text-align:center; margin-top:30px; }
</style>
</head><body><div class="wrap">
  <div class="masthead">
    <div class="eyebrow">${brandEyebrow}</div>
    <h1>Investor Snapshot</h1>
    <div class="sub">Generated ${fmtDate(new Date())} · Read-only performance summary</div>
  </div>

  <div class="cards">
    <div class="card"><div class="l">This Week Sales</div><div class="v" style="color:#2F5233;">${naira(thisWeek.sales)}</div></div>
    <div class="card"><div class="l">This Week Profit</div><div class="v" style="color:${thisWeek.profit >= 0 ? "#2F5233" : "#A6491E"};">${naira(thisWeek.profit)}</div></div>
  </div>
  <div class="cards">
    <div class="card"><div class="l">This Month Sales</div><div class="v" style="color:#2F5233;">${naira(thisMonth.sales)}</div></div>
    <div class="card"><div class="l">This Month Profit</div><div class="v" style="color:${thisMonth.profit >= 0 ? "#2F5233" : "#A6491E"};">${naira(thisMonth.profit)}</div></div>
  </div>

  <div class="section-title">Last 8 Weeks</div>
  <div class="legend"><span><span class="dot" style="background:#2F5233;"></span>Sales</span><span><span class="dot" style="background:#A6491E;"></span>Expenses</span></div>
  ${investorTrend.weeks.map((w) => barRow(w.label, w.sales, w.expenses, w.profit, maxWeekVal)).join("")}

  <div class="section-title">Last 6 Months</div>
  <div class="legend"><span><span class="dot" style="background:#2F5233;"></span>Sales</span><span><span class="dot" style="background:#A6491E;"></span>Expenses</span></div>
  ${investorTrend.months.map((m) => barRow(m.label, m.sales, m.expenses, m.profit, maxMonthVal)).join("")}

  <div class="footer">Prepared for informational purposes. Figures reflect company-operated activity only.</div>
</div></body></html>`;

    try {
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${brandSlug}-investor-snapshot-${todayStr()}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setSaveError("Could not generate investor snapshot.");
    }
  };

  const downloadInvoiceFile = (sale, invoiceNo) => {
    const isCredit = sale.source === "Credit";
    const statusLabel = isCredit
      ? sale.status === "paid"
        ? `PAID (Credit — settled)`
        : `PAYMENT DUE${sale.dueDate ? ` BY ${fmtDate(new Date(sale.dueDate + "T00:00:00"))}` : ""}`
      : `PAID — ${sale.method || "Cash"}`;
    const statusColor = isCredit && sale.status !== "paid" ? "#A6491E" : "#2F5233";

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<title>${brandEyebrow} — Invoice ${invoiceNo}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600;700&display=swap');
body { margin:0; padding:24px 16px 60px; background:#F6F3EC; color:#21281F; font-family:'Inter',sans-serif; }
.wrap { max-width: 560px; margin: 0 auto; background:#fff; border:1px solid #D8D2C2; border-radius:12px; padding:28px; }
.top { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #21281F; padding-bottom:16px; margin-bottom:20px; }
.eyebrow { font-size:11px; letter-spacing:0.18em; color:#C9A227; font-weight:700; }
h1 { font-family:'Fraunces',serif; font-size:26px; margin:2px 0 0; }
.meta { text-align:right; font-size:12px; color:#7A7566; }
.meta .no { font-family:'IBM Plex Mono',monospace; font-weight:700; color:#21281F; font-size:13px; }
.row { display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid #D8D2C2; font-size:14px; }
.row .label { color:#7A7566; }
.total { display:flex; justify-content:space-between; padding:16px 0 0; margin-top:6px; font-weight:700; font-size:18px; }
.total .amt { font-family:'IBM Plex Mono',monospace; }
.status { display:inline-block; margin-top:18px; padding:7px 14px; border-radius:20px; font-size:12px; font-weight:700; color:#fff; background:${statusColor}; }
.footer { font-size:11px; color:#7A7566; text-align:center; margin-top:28px; }
</style>
</head><body><div class="wrap">
  <div class="top">
    <div>
      <div class="eyebrow">${brandEyebrow}</div>
      <h1>${brandTitle}</h1>
    </div>
    <div class="meta">
      <div class="no">${invoiceNo}</div>
      <div>${fmtDate(new Date(sale.date + "T00:00:00"))}</div>
    </div>
  </div>

  <div class="row"><span class="label">Billed To</span><span>${sale.customerName ? sale.customerName : "Walk-in Customer"}</span></div>
  <div class="row"><span class="label">Item</span><span>${categoryLabel(categories, "income", sale.category)}${sale.description ? " — " + sale.description : ""}</span></div>
  <div class="row"><span class="label">Payment Type</span><span>${isCredit ? "Credit" : "Cash"}</span></div>

  <div class="total"><span>Total</span><span class="amt">${naira(sale.amount)}</span></div>
  <div class="status">${statusLabel}</div>

  <div class="footer">Thank you for your business.</div>
</div></body></html>`;

    try {
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${brandSlug}-invoice-${invoiceNo}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setSaveError("Could not generate invoice.");
    }
  };

  const saveBusinessProfile = async () => {
    if (!requireManager()) return;
    const next = {
      name: profileDraft.name.trim(),
      phone: profileDraft.phone.trim(),
      address: profileDraft.address.trim(),
      note: profileDraft.note.trim(),
    };
    setBusinessProfile(next);
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2500);
    try {
      if (window.storage) await window.storage.set("business_profile", JSON.stringify(next), false);
    } catch (e) {
      setSaveError("Could not save business details.");
    }
  };

  const invoiceStatus = (sale) => {
    const isCredit = sale.source === "Credit";
    if (isCredit) {
      if (sale.status === "paid") return { label: "PAID (Credit - settled)", color: "#2F5233" };
      return {
        label: `PAYMENT DUE${sale.dueDate ? ` BY ${fmtDate(new Date(sale.dueDate + "T00:00:00"))}` : ""}`,
        color: "#A6491E",
      };
    }
    return { label: `PAID - ${sale.method || "Cash"}`, color: "#2F5233" };
  };

  const buildInvoiceText = (sale, invoiceNo) => {
    const st = invoiceStatus(sale);
    return [
      `*${brandEyebrow}*`,
      ...(businessProfile.phone ? [businessProfile.phone] : []),
      ...(businessProfile.address ? [businessProfile.address] : []),
      ``,
      `Invoice: ${invoiceNo}`,
      `Date: ${fmtDate(new Date(sale.date + "T00:00:00"))}`,
      ``,
      `Billed to: ${sale.customerName || "Walk-in Customer"}`,
      `Item: ${categoryLabel(categories, "income", sale.category)}${sale.description ? " - " + sale.description : ""}`,
      `Payment type: ${sale.source === "Credit" ? "Credit" : "Cash"}`,
      ``,
      `*Total: ${naira(sale.amount)}*`,
      `Status: ${st.label}`,
      ``,
      ...(businessProfile.note ? [businessProfile.note, ``] : []),
      `Thank you for your business.`,
    ].join("\n");
  };

  const normalizePhone = (raw) => {
    const digits = (raw || "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.startsWith("234")) return digits;
    if (digits.startsWith("0")) return "234" + digits.slice(1);
    if (digits.length === 10) return "234" + digits;
    return digits;
  };

  const buildInvoiceCanvas = (sale, invoiceNo) => {
    const W = 800;
    const P = 48;
    const big = document.createElement("canvas");
    big.width = W;
    big.height = 1800;
    const ctx = big.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, 1800);
    const sans = "Inter, Helvetica, Arial, sans-serif";
    const mono = "'IBM Plex Mono', Consolas, monospace";
    const INK = "#21281F";
    const GOLD = "#C9A227";
    const MUTED = "#7A7566";
    const LINE = "#D8D2C2";

    const wrap = (text, maxW, font) => {
      ctx.font = font;
      const words = String(text || "").split(/\s+/).filter(Boolean);
      const lines = [];
      let line = "";
      words.forEach((w) => {
        const t = line ? line + " " + w : w;
        if (ctx.measureText(t).width > maxW && line) {
          lines.push(line);
          line = w;
        } else {
          line = t;
        }
      });
      if (line) lines.push(line);
      return lines.length ? lines : [""];
    };

    // header — left: business
    ctx.textAlign = "left";
    let yl = P + 30;
    ctx.fillStyle = INK;
    wrap(displayName, 430, `700 32px ${sans}`).forEach((l) => {
      ctx.font = `700 32px ${sans}`;
      ctx.fillText(l, P, yl);
      yl += 38;
    });
    ctx.fillStyle = MUTED;
    const sub = [];
    if (businessProfile.phone) sub.push(businessProfile.phone);
    if (businessProfile.address) wrap(businessProfile.address, 430, `400 18px ${sans}`).forEach((l) => sub.push(l));
    sub.forEach((l) => {
      ctx.font = `400 18px ${sans}`;
      ctx.fillText(l, P, yl - 4);
      yl += 26;
    });

    // header — right: invoice meta
    ctx.textAlign = "right";
    let yr = P + 30;
    ctx.fillStyle = GOLD;
    ctx.font = `700 26px ${sans}`;
    ctx.fillText("INVOICE", W - P, yr);
    yr += 32;
    ctx.fillStyle = INK;
    ctx.font = `700 17px ${mono}`;
    ctx.fillText(invoiceNo, W - P, yr);
    yr += 26;
    ctx.fillStyle = MUTED;
    ctx.font = `400 18px ${sans}`;
    ctx.fillText(fmtDate(new Date(sale.date + "T00:00:00")), W - P, yr);

    let y = Math.max(yl, yr) + 6;
    ctx.fillStyle = INK;
    ctx.fillRect(P, y, W - 2 * P, 3);
    y += 40;

    // rows
    const rows = [
      ["Billed To", sale.customerName || "Walk-in Customer"],
      [
        "Item",
        `${categoryLabel(categories, "income", sale.category)}${sale.description ? " - " + sale.description : ""}`,
      ],
      ["Payment Type", sale.source === "Credit" ? "Credit" : "Cash"],
    ];
    rows.forEach(([k, v]) => {
      ctx.textAlign = "left";
      ctx.fillStyle = MUTED;
      ctx.font = `400 20px ${sans}`;
      ctx.fillText(k, P, y);
      ctx.textAlign = "right";
      ctx.fillStyle = INK;
      const lines = wrap(v, 460, `500 22px ${sans}`);
      ctx.font = `500 22px ${sans}`;
      lines.forEach((l, i) => ctx.fillText(l, W - P, y + i * 30));
      y += (lines.length - 1) * 30 + 20;
      ctx.fillStyle = LINE;
      ctx.fillRect(P, y, W - 2 * P, 1);
      y += 40;
    });

    // total
    y += 10;
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    ctx.font = `700 28px ${sans}`;
    ctx.fillText("Total", P, y);
    ctx.textAlign = "right";
    ctx.font = `700 36px ${mono}`;
    ctx.fillText(naira(sale.amount), W - P, y);
    y += 44;

    // status pill
    const st = invoiceStatus(sale);
    ctx.font = `700 20px ${sans}`;
    const tw = ctx.measureText(st.label).width;
    const pw = tw + 44;
    const ph = 46;
    const px = P;
    ctx.fillStyle = st.color;
    const r = ph / 2;
    ctx.beginPath();
    ctx.moveTo(px + r, y);
    ctx.lineTo(px + pw - r, y);
    ctx.arc(px + pw - r, y + r, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(px + r, y + ph);
    ctx.arc(px + r, y + r, r, Math.PI / 2, (3 * Math.PI) / 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.fillText(st.label, px + 22, y + 30);
    y += ph + 44;

    // footer
    ctx.textAlign = "center";
    ctx.fillStyle = MUTED;
    ctx.font = `400 18px ${sans}`;
    if (businessProfile.note) {
      wrap(businessProfile.note, W - 2 * P, `400 18px ${sans}`).forEach((l) => {
        ctx.font = `400 18px ${sans}`;
        ctx.fillText(l, W / 2, y);
        y += 26;
      });
      y += 6;
    }
    ctx.fillText("Thank you for your business.", W / 2, y);
    y += P;

    const out = document.createElement("canvas");
    out.width = W;
    out.height = y;
    out.getContext("2d").drawImage(big, 0, 0, W, y, 0, 0, W, y);
    return out;
  };

  useEffect(() => {
    if (!invoiceView) {
      setInvoiceImageUrl("");
      return;
    }
    try {
      const cv = buildInvoiceCanvas(invoiceView.sale, invoiceView.invoiceNo);
      setInvoiceImageUrl(cv.toDataURL("image/png"));
    } catch (e) {
      setInvoiceImageUrl("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceView, businessProfile]);

  const shareInvoiceImage = async () => {
    if (!invoiceView) return;
    try {
      const cv = buildInvoiceCanvas(invoiceView.sale, invoiceView.invoiceNo);
      const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
      if (!blob) throw new Error("no image");
      const file = new File([blob], `${brandSlug}-${invoiceView.invoiceNo}.png`, { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `Invoice ${invoiceView.invoiceNo}` });
        setInvoiceNote("In the share menu, choose WhatsApp, then pick the customer.");
      } else {
        setInvoiceNote(
          "This viewer can't share images directly. Press and hold the invoice image to save it, then attach it in WhatsApp. Opening this page in Chrome usually enables direct sharing."
        );
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
      setInvoiceNote(
        "Couldn't open the share menu here. Press and hold the invoice image to save it, or open this page in Chrome."
      );
    }
  };

  const invoiceBlobUrl = async () => {
    const cv = buildInvoiceCanvas(invoiceView.sale, invoiceView.invoiceNo);
    const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
    if (!blob) throw new Error("no image");
    return URL.createObjectURL(blob);
  };

  const saveInvoiceImage = async () => {
    if (!invoiceView) return;
    try {
      const url = await invoiceBlobUrl();
      const a = document.createElement("a");
      a.href = url;
      a.download = `${brandSlug}-${invoiceView.invoiceNo}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setInvoiceNote("If nothing saved, press and hold the invoice image above and choose Save image — or open this page in Chrome.");
    } catch (e) {
      setInvoiceNote("Couldn't save here. Press and hold the invoice image and choose Save image, or open this page in Chrome.");
    }
  };

  const openInvoiceImage = async () => {
    if (!invoiceView) return;
    try {
      const url = await invoiceBlobUrl();
      const w = window.open(url, "_blank");
      if (!w) window.location.href = url;
    } catch (e) {
      setInvoiceNote("Couldn't open the image here. Press and hold the invoice image and choose Save image.");
    }
  };

  const generateInvoice = (sale) => {
    const invoiceNo = `INV-${sale.date.replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    setInvoiceNote("");
    setInvoicePhone(sale.customerPhone || "");
    setInvoiceView({ sale, invoiceNo });
  };

  const sendInvoiceWhatsApp = () => {
    if (!invoiceView) return;
    const text = buildInvoiceText(invoiceView.sale, invoiceView.invoiceNo);
    const phone = normalizePhone(invoicePhone);
    const url = phone
      ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
      : `https://wa.me/?text=${encodeURIComponent(text)}`;
    const w = window.open(url, "_blank");
    if (!w) window.location.href = url;
    setInvoiceNote(phone ? "Opening WhatsApp with the invoice ready to send." : "Opening WhatsApp — choose who to send it to.");
  };

  const copyInvoiceText = async () => {
    if (!invoiceView) return;
    const text = buildInvoiceText(invoiceView.sale, invoiceView.invoiceNo);
    try {
      await navigator.clipboard.writeText(text);
      setInvoiceNote("Invoice text copied — paste it anywhere.");
    } catch (e) {
      setInvoiceNote("Couldn't copy automatically. Use the WhatsApp button instead.");
    }
  };

  const recordExpense = () => {
    if (!requireManager()) return;
    const amt = parseMoney(expenseForm.amount);
    const cat = categories.expense.some((x) => x.id === expenseForm.category)
      ? expenseForm.category
      : categories.expense[0] && categories.expense[0].id;
    if (!expenseForm.date || !amt || amt <= 0 || !cat) return;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      date: expenseForm.date,
      type: "expense",
      category: cat,
      description: expenseForm.description.trim(),
      amount: amt,
      method: expenseForm.method,
      requestedBy: expenseForm.recordedBy.trim(),
    };
    persist([entry, ...transactions].sort((a, b) => (a.date < b.date ? 1 : -1)));
    setExpenseSaved(`✓ ${naira(amt)} expense recorded`);
    setTimeout(() => setExpenseSaved(""), 3000);
    setExpenseForm((f) => ({ ...f, description: "", amount: "" }));
  };

  const salesEntryJsx = (
    <div>
          <div style={styles.typeToggle}>
            <button
              onClick={() => setSalesForm((f) => ({ ...f, saleType: "cash", method: "Cash" }))}
              style={{
                ...styles.toggleBtn,
                ...(salesForm.saleType === "cash" ? { background: COLORS.green, color: "#fff" } : {}),
              }}
            >
              Cash Sale
            </button>
            <button
              onClick={() => setSalesForm((f) => ({ ...f, saleType: "credit" }))}
              style={{
                ...styles.toggleBtn,
                ...(salesForm.saleType === "credit" ? { background: COLORS.gold, color: "#fff" } : {}),
              }}
            >
              Credit Sale
            </button>
          </div>
          <div style={styles.hintNote}>
            {salesForm.saleType === "cash"
              ? "Cash received now — this goes straight into Money In."
              : "Payment comes later — this goes to the Credit ledger as outstanding until they pay."}
          </div>

          <div style={{ ...styles.form, marginTop: 14 }}>
            <label style={styles.label}>
              Date
              <input
                type="date"
                value={salesForm.date}
                onChange={(e) => setSalesForm((f) => ({ ...f, date: e.target.value }))}
                style={styles.input}
              />
            </label>

            <label style={styles.label}>
              Customer Name {salesForm.saleType === "credit" ? "" : "(optional)"}
              <input
                type="text"
                placeholder="e.g. Mrs. Okafor"
                value={salesForm.customerName}
                onChange={(e) => setSalesForm((f) => ({ ...f, customerName: e.target.value }))}
                style={styles.input}
              />
            </label>

            <label style={styles.label}>
              Category
              <select
                value={salesForm.category}
                onChange={(e) => setSalesForm((f) => ({ ...f, category: e.target.value }))}
                style={styles.input}
              >
                {categories.income.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>

            <label style={styles.label}>
              Description
              <input
                type="text"
                placeholder="e.g. 12kg goat meat"
                value={salesForm.description}
                onChange={(e) => setSalesForm((f) => ({ ...f, description: e.target.value }))}
                style={styles.input}
              />
            </label>

            <label style={styles.label}>
              Amount (₦)
              <input
                type="number"
                min="0"
                step="1"
                placeholder="0"
                value={salesForm.amount}
                onChange={(e) => setSalesForm((f) => ({ ...f, amount: e.target.value }))}
                style={{ ...styles.input, fontFamily: "'IBM Plex Mono', monospace" }}
              />
            </label>

            {salesForm.saleType === "cash" ? (
              <label style={styles.label}>
                Payment Method
                <select
                  value={salesForm.method}
                  onChange={(e) => setSalesForm((f) => ({ ...f, method: e.target.value }))}
                  style={styles.input}
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label style={styles.label}>
                Expected Payment Date (optional)
                <input
                  type="date"
                  value={salesForm.dueDate}
                  onChange={(e) => setSalesForm((f) => ({ ...f, dueDate: e.target.value }))}
                  style={styles.input}
                />
              </label>
            )}

            <label style={styles.label}>
              Recorded By (optional)
              <input
                type="text"
                placeholder="e.g. Chidi"
                value={salesForm.recordedBy}
                onChange={(e) => setSalesForm((f) => ({ ...f, recordedBy: e.target.value }))}
                style={styles.input}
              />
            </label>

            <button type="button" onClick={recordSale} style={styles.submitBtn}>
              Record {salesForm.saleType === "cash" ? "Cash Sale" : "Credit Sale"}
            </button>
          </div>

          {lastSale && (
            <div style={{ ...styles.creditRow, marginTop: 16, borderColor: COLORS.green }}>
              <div style={{ fontSize: 12, color: COLORS.green, fontWeight: 700, marginBottom: 4 }}>✓ Sale Recorded</div>
              <div style={{ fontSize: 13, color: COLORS.muted, marginBottom: 10 }}>
                {naira(lastSale.amount)} — {lastSale.customerName || "Walk-in Customer"} ({lastSale.source})
              </div>
              <button type="button" onClick={() => generateInvoice(lastSale)} style={styles.confirmBtn}>
                Generate Invoice
              </button>
            </div>
          )}
    </div>
  );

  const expenseEntryJsx = (
    <div>
      <div style={styles.form}>
        <label style={styles.label}>
          Date
          <input
            type="date"
            value={expenseForm.date}
            onChange={(e) => setExpenseForm((f) => ({ ...f, date: e.target.value }))}
            style={styles.input}
          />
        </label>
        <label style={styles.label}>
          Category
          <select
            value={categories.expense.some((x) => x.id === expenseForm.category) ? expenseForm.category : (categories.expense[0] && categories.expense[0].id) || ""}
            onChange={(e) => setExpenseForm((f) => ({ ...f, category: e.target.value }))}
            style={styles.input}
          >
            {categories.expense.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.label}>
          Description
          <input
            type="text"
            placeholder="e.g. Fuel for delivery van"
            value={expenseForm.description}
            onChange={(e) => setExpenseForm((f) => ({ ...f, description: e.target.value }))}
            style={styles.input}
          />
        </label>
        <label style={styles.label}>
          Amount (₦)
          <input
            type="number"
            min="0"
            step="1"
            placeholder="0"
            value={expenseForm.amount}
            onChange={(e) => setExpenseForm((f) => ({ ...f, amount: e.target.value }))}
            style={{ ...styles.input, fontFamily: "'IBM Plex Mono', monospace" }}
          />
        </label>
        <label style={styles.label}>
          Payment Method
          <select
            value={expenseForm.method}
            onChange={(e) => setExpenseForm((f) => ({ ...f, method: e.target.value }))}
            style={styles.input}
          >
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.label}>
          Recorded By (optional)
          <input
            type="text"
            placeholder="e.g. Chidi"
            value={expenseForm.recordedBy}
            onChange={(e) => setExpenseForm((f) => ({ ...f, recordedBy: e.target.value }))}
            style={styles.input}
          />
        </label>
        <button type="button" onClick={recordExpense} style={styles.submitBtn}>
          Record Expense
        </button>
        {expenseSaved && <div style={{ fontSize: 13, color: COLORS.green, fontWeight: 700 }}>{expenseSaved}</div>}
      </div>
    </div>
  );

  const procurementEntryJsx = (
    <div>
              <div style={styles.statementTitle}>Record Procurement</div>
              <div style={styles.form}>
                <label style={styles.label}>
                  Date
                  <input
                    type="date"
                    value={procurementForm.date}
                    onChange={(e) => setProcurementForm((f) => ({ ...f, date: e.target.value }))}
                    style={styles.input}
                  />
                </label>
                <label style={styles.label}>
                  Supplier (optional)
                  <input
                    type="text"
                    placeholder="e.g. Alaba Livestock Market"
                    value={procurementForm.supplier}
                    onChange={(e) => setProcurementForm((f) => ({ ...f, supplier: e.target.value }))}
                    style={styles.input}
                  />
                </label>
                <label style={styles.label}>
                  Category
                  <select
                    value={procurementForm.category}
                    onChange={(e) => setProcurementForm((f) => ({ ...f, category: e.target.value }))}
                    style={styles.input}
                  >
                    {categories.expense.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                        {c.cogs ? " (COGS)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={styles.label}>
                  Description
                  <input
                    type="text"
                    placeholder="e.g. 40kg beef, 2 crates chicken"
                    value={procurementForm.description}
                    onChange={(e) => setProcurementForm((f) => ({ ...f, description: e.target.value }))}
                    style={styles.input}
                  />
                </label>
                <label style={styles.label}>
                  Total Amount (₦)
                  <input
                    type="number"
                    min="0"
                    placeholder="0"
                    value={procurementForm.amount}
                    onChange={(e) => setProcurementForm((f) => ({ ...f, amount: e.target.value }))}
                    style={{ ...styles.input, fontFamily: "'IBM Plex Mono', monospace" }}
                  />
                </label>
                <label style={styles.label}>
                  Payment Method
                  <select
                    value={procurementForm.method}
                    onChange={(e) => setProcurementForm((f) => ({ ...f, method: e.target.value }))}
                    style={styles.input}
                  >
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>

                {stockItems.length > 0 && (
                  <>
                    <label style={styles.label}>
                      Add to Stock Item (optional)
                      <select
                        value={procurementForm.stockItemId}
                        onChange={(e) => setProcurementForm((f) => ({ ...f, stockItemId: e.target.value }))}
                        style={styles.input}
                      >
                        <option value="">— Don't update stock —</option>
                        {stockItems.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} ({s.unit})
                          </option>
                        ))}
                      </select>
                    </label>
                    {procurementForm.stockItemId && (
                      <label style={styles.label}>
                        Quantity Received
                        <input
                          type="number"
                          min="0"
                          placeholder="0"
                          value={procurementForm.quantity}
                          onChange={(e) => setProcurementForm((f) => ({ ...f, quantity: e.target.value }))}
                          style={{ ...styles.input, fontFamily: "'IBM Plex Mono', monospace" }}
                        />
                      </label>
                    )}
                  </>
                )}

                <label style={styles.label}>
                  Recorded By (optional)
                  <input
                    type="text"
                    placeholder="e.g. Chidi"
                    value={procurementForm.recordedBy}
                    onChange={(e) => setProcurementForm((f) => ({ ...f, recordedBy: e.target.value }))}
                    style={styles.input}
                  />
                </label>
                <button type="button" onClick={recordProcurement} style={styles.submitBtn}>
                  Record Procurement
                </button>
              </div>

    </div>
  );

  const stockEntryJsx = (
    <div>
      <div style={styles.form}>
        <label style={styles.label}>
          Stock Item
          <select value={recordStockItemId} onChange={(e) => setRecordStockItemId(e.target.value)} style={styles.input}>
            <option value="">— Select item —</option>
            {stockItems.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.unit}) — balance {(stockBalances[s.id] || 0).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        <div style={styles.typeToggle}>
          <button
            onClick={() => setStockMoveForm((f) => ({ ...f, type: "in" }))}
            style={{ ...styles.toggleBtn, ...(stockMoveForm.type === "in" ? { background: COLORS.green, color: "#fff" } : {}) }}
          >
            Goods In
          </button>
          <button
            onClick={() => setStockMoveForm((f) => ({ ...f, type: "out" }))}
            style={{ ...styles.toggleBtn, ...(stockMoveForm.type === "out" ? { background: COLORS.rust, color: "#fff" } : {}) }}
          >
            Goods Out
          </button>
        </div>
        <label style={styles.label}>
          Date
          <input
            type="date"
            value={stockMoveForm.date}
            onChange={(e) => setStockMoveForm((f) => ({ ...f, date: e.target.value }))}
            style={styles.input}
          />
        </label>
        <label style={styles.label}>
          Quantity
          <input
            type="number"
            min="0"
            placeholder="0"
            value={stockMoveForm.quantity}
            onChange={(e) => setStockMoveForm((f) => ({ ...f, quantity: e.target.value }))}
            style={{ ...styles.input, fontFamily: "'IBM Plex Mono', monospace" }}
          />
        </label>
        <label style={styles.label}>
          Note (optional)
          <input
            type="text"
            placeholder="e.g. Delivery from supplier / Sold"
            value={stockMoveForm.note}
            onChange={(e) => setStockMoveForm((f) => ({ ...f, note: e.target.value }))}
            style={styles.input}
          />
        </label>
        <button type="button" onClick={() => addStockMovement(recordStockItemId)} style={styles.submitBtn}>
          Record {stockMoveForm.type === "in" ? "Goods In" : "Goods Out"}
        </button>
        {stockSaved && <div style={{ fontSize: 13, color: COLORS.green, fontWeight: 700 }}>{stockSaved}</div>}
        {stockItems.length === 0 && (
          <div style={styles.hintNote}>No stock items yet. Add one first under Books → Stock Book.</div>
        )}
      </div>
    </div>
  );

  const dispatchEntryJsx = (
    <div>
      <div style={styles.form}>
        <label style={styles.label}>
          Ecommerce / Vendor Name
          <input
            type="text"
            placeholder="e.g. Jumia, or a direct merchant"
            value={dispatchForm.vendorName}
            onChange={(e) => setDispatchForm((f) => ({ ...f, vendorName: e.target.value }))}
            style={styles.input}
          />
        </label>
        <label style={styles.label}>
          Merchant Name
          <input
            type="text"
            value={dispatchForm.merchantName}
            onChange={(e) => setDispatchForm((f) => ({ ...f, merchantName: e.target.value }))}
            style={styles.input}
          />
        </label>
        <label style={styles.label}>
          Destination / Location
          <input
            type="text"
            value={dispatchForm.destination}
            onChange={(e) => setDispatchForm((f) => ({ ...f, destination: e.target.value }))}
            style={styles.input}
          />
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <label style={{ ...styles.label, flex: 1 }}>
            Unit
            <input
              type="text"
              placeholder="e.g. 2 pieces"
              value={dispatchForm.unit}
              onChange={(e) => setDispatchForm((f) => ({ ...f, unit: e.target.value }))}
              style={styles.input}
            />
          </label>
          <label style={{ ...styles.label, flex: 2 }}>
            Product Name
            <input
              type="text"
              value={dispatchForm.productName}
              onChange={(e) => setDispatchForm((f) => ({ ...f, productName: e.target.value }))}
              style={styles.input}
            />
          </label>
        </div>
        <label style={styles.label}>
          Product Amount (₦) — the COD amount collected for the vendor, not your income
          <input
            type="number"
            min="0"
            placeholder="0"
            value={dispatchForm.productAmount}
            onChange={(e) => setDispatchForm((f) => ({ ...f, productAmount: e.target.value }))}
            style={{ ...styles.input, fontFamily: "'IBM Plex Mono', monospace" }}
          />
        </label>
        <label style={styles.label}>
          Date of Dispatch
          <input
            type="date"
            value={dispatchForm.date}
            onChange={(e) => setDispatchForm((f) => ({ ...f, date: e.target.value }))}
            style={styles.input}
          />
        </label>
        <label style={styles.label}>
          Receiver Phone Number
          <input
            type="tel"
            value={dispatchForm.receiverPhone}
            onChange={(e) => setDispatchForm((f) => ({ ...f, receiverPhone: e.target.value }))}
            style={styles.input}
          />
        </label>
        <label style={styles.label}>
          Dispatcher
          <select
            value={dispatchForm.dispatcherId}
            onChange={(e) => setDispatchForm((f) => ({ ...f, dispatcherId: e.target.value }))}
            style={styles.input}
          >
            <option value="">— Select —</option>
            {workers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.label}>
          BDO
          <select
            value={dispatchForm.bdoId}
            onChange={(e) => setDispatchForm((f) => ({ ...f, bdoId: e.target.value }))}
            style={styles.input}
          >
            <option value="">— Select —</option>
            {workers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        {workers.length === 0 && (
          <div style={styles.hintNote}>No workers added yet. Add dispatchers/BDOs under Settings → Workers.</div>
        )}
        <label style={styles.label}>
          Delivery Amount (₦) — your actual service charge income
          <input
            type="number"
            min="0"
            placeholder="0"
            value={dispatchForm.deliveryAmount}
            onChange={(e) => setDispatchForm((f) => ({ ...f, deliveryAmount: e.target.value }))}
            style={{ ...styles.input, fontFamily: "'IBM Plex Mono', monospace" }}
          />
        </label>
        <label style={{ ...styles.label, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={dispatchForm.chargeIncluded}
            onChange={(e) => setDispatchForm((f) => ({ ...f, chargeIncluded: e.target.checked }))}
          />
          Service charge is included within the Product Amount above
        </label>
        <div style={styles.hintNote}>
          {dispatchForm.chargeIncluded
            ? "Vendor will be owed Product Amount minus Delivery Amount."
            : "Vendor will be owed the full Product Amount — delivery amount is charged separately."}
        </div>
        <button type="button" onClick={recordDispatch} style={styles.submitBtn}>
          Log Delivery
        </button>
        {dispatchNote && <div style={{ fontSize: 13, color: COLORS.green, fontWeight: 700 }}>{dispatchNote}</div>}
      </div>
    </div>
  );

  const booksNavJsx = (
    <div style={{ ...styles.typeToggle, marginBottom: 14 }}>
      {[
        ["ledger", "Ledgers"],
        ["credit", "Customer Credit"],
        ["stock", "Stock Book"],
        ["dispatch", "Dispatch Book"],
      ].map(([k, l]) => (
        <button
          key={k}
          onClick={() => setTab(k)}
          style={{ ...styles.toggleBtn, ...(tab === k ? { background: COLORS.gold, color: "#fff", borderColor: COLORS.gold } : {}) }}
        >
          {l}
        </button>
      ))}
    </div>
  );

  const dashboard = useMemo(() => {
    const today = todayStr();
    const month = today.slice(0, 7);
    const sum = (arr) => arr.reduce((s, x) => s + x.amount, 0);
    const salesToday =
      sum(transactions.filter((t) => t.type === "income" && !isCreditSettlement(t) && t.date === today)) +
      sum(creditSales.filter((x) => x.date === today));
    const expensesToday = sum(transactions.filter((t) => t.type === "expense" && t.date === today));
    const salesMonth =
      sum(transactions.filter((t) => t.type === "income" && !isCreditSettlement(t) && t.date.slice(0, 7) === month)) +
      sum(creditSales.filter((x) => x.date.slice(0, 7) === month));
    const expensesMonth = sum(transactions.filter((t) => t.type === "expense" && t.date.slice(0, 7) === month));
    const overdue = creditSales.filter((x) => x.status === "outstanding" && x.dueDate && x.dueDate < today);
    const lowStock = stockItems.filter((s) => (stockBalances[s.id] || 0) <= 0);
    return { salesToday, expensesToday, salesMonth, expensesMonth, overdue, overdueTotal: sum(overdue), lowStock };
  }, [transactions, creditSales, stockItems, stockBalances]);

  const attentionItems = [];
  if (pendingList.length > 0)
    attentionItems.push({
      text: `${pendingList.length} budget item${pendingList.length > 1 ? "s" : ""} awaiting your decision (${naira(pendingTotal)})`,
      action: "Review",
      go: () => {
        setTab("budgets");
        setBudgetSubTab("review");
      },
    });
  if (approvedAwaitingRetire.length > 0)
    attentionItems.push({
      text: `${approvedAwaitingRetire.length} approved item${approvedAwaitingRetire.length > 1 ? "s" : ""} waiting to be paid and retired`,
      action: "Retire",
      go: () => {
        setTab("budgets");
        setBudgetSubTab("retire");
      },
    });
  if (dashboard.overdue.length > 0)
    attentionItems.push({
      text: `${dashboard.overdue.length} overdue customer payment${dashboard.overdue.length > 1 ? "s" : ""} (${naira(dashboard.overdueTotal)})`,
      action: "Collect",
      go: () => setTab("credit"),
    });
  if (dashboard.lowStock.length > 0)
    attentionItems.push({
      text: `Out of stock: ${dashboard.lowStock.map((s) => s.name).join(", ")}`,
      action: "Stock",
      go: () => setTab("stock"),
    });
  if (totalHeldForVendors > 0)
    attentionItems.push({
      text: `${naira(totalHeldForVendors)} collected on delivery is still owed to vendors`,
      action: "Remit",
      go: () => setTab("dispatch"),
    });
  const unpaidCommissionTotal = workerCommissionSummary.reduce((s, w) => s + w.unpaid, 0);
  if (unpaidCommissionTotal > 0)
    attentionItems.push({
      text: `${naira(unpaidCommissionTotal)} in commission not yet paid out`,
      action: "Pay",
      go: () => setTab("dispatch"),
    });

  return (
    <div style={styles.app}>
      <style>{`
        ${FONT_IMPORT}
        * { box-sizing: border-box; }
        input, select { font-family: 'Inter', sans-serif; }
        table { border-collapse: collapse; width: 100%; }
        ::placeholder { color: #A9A296; }
        @media print {
          .no-print { display: none !important; }
          body { background: white; }
        }
      `}</style>

      <header style={styles.header}>
        <div style={styles.masthead}>
          <div style={styles.mastheadEyebrow}>{brandEyebrow}</div>
          <h1 style={styles.mastheadTitle}>{brandTitle}</h1>
          <div style={styles.mastheadSub}>{brandTagline}</div>
        </div>
        <div style={styles.stub}>
          <div style={styles.stubRow}>
            <span style={styles.stubLabel}>In</span>
            <span style={{ ...styles.stubValue, color: COLORS.green }}>{naira(totals.income)}</span>
          </div>
          <div style={styles.stubRow}>
            <span style={styles.stubLabel}>Out</span>
            <span style={{ ...styles.stubValue, color: COLORS.rust }}>{naira(totals.expense)}</span>
          </div>
          <div style={styles.stubDivider} />
          <div style={styles.stubRow}>
            <span style={{ ...styles.stubLabel, fontWeight: 700 }}>Balance</span>
            <span style={{ ...styles.stubValue, fontWeight: 700, fontSize: 20 }}>{naira(totals.balance)}</span>
          </div>
          {outstandingTotal > 0 && (
            <div style={styles.stubRow}>
              <span style={{ ...styles.stubLabel, color: COLORS.gold }}>Owed to you (credit)</span>
              <span style={{ ...styles.stubValue, color: COLORS.gold }}>{naira(outstandingTotal)}</span>
            </div>
          )}
          {pendingList.length > 0 && (
            <div style={styles.stubRow}>
              <span style={{ ...styles.stubLabel, color: COLORS.rust }}>Budget items awaiting decision ({pendingList.length})</span>
              <span style={{ ...styles.stubValue, color: COLORS.rust }}>{naira(pendingTotal)}</span>
            </div>
          )}
        </div>
      </header>

      <nav style={{ ...styles.tabs, flexWrap: "wrap" }} className="no-print">
        {[
          ["home", "Home", ["home"]],
          ["record", "Record", ["record", "sales"]],
          ["ledger", "Books", ["ledger", "credit", "stock"]],
          ["budgets", `Approvals${pendingList.length ? ` (${pendingList.length})` : ""}`, ["budgets"]],
          ["reports", "Reports", ["reports"]],
          ["settings", "Settings", ["settings"]],
        ].map(([key, label, group]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{ ...styles.tabBtn, flex: "1 0 30%", ...(group.includes(tab) ? styles.tabBtnActive : {}) }}
          >
            {label}
          </button>
        ))}
      </nav>

      {role === "viewer" && <div style={{ ...styles.errorBanner, background: "#EFEBE0", color: COLORS.ink }}>View-only access. Contact an organization owner if you need to record or update ledger entries.</div>}
      {role === "staff" && <div style={{ ...styles.errorBanner, background: "#EFEBE0", color: COLORS.ink }}>Staff access: you can record sales and dispatches. An owner or accountant manages expenses, approvals, payments, settings, and edits.</div>}
      {saveError && <div style={styles.errorBanner}>{saveError}</div>}
      {!loaded && <div style={styles.loading}>Loading ledger…</div>}

      {loaded && tab === "sales" && (
        <section style={styles.card}>
          {salesEntryJsx}
        </section>
      )}

      {loaded && tab === "home" && (
        <div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            <StatCard label="Today's Sales" value={naira(dashboard.salesToday)} color={COLORS.green} />
            <StatCard label="Today's Expenses" value={naira(dashboard.expensesToday)} color={COLORS.rust} />
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            <StatCard label="Cash Balance" value={naira(totals.balance)} color={totals.balance < 0 ? COLORS.rust : COLORS.ink} />
            <StatCard label="Owed by Customers" value={naira(outstandingTotal)} color={COLORS.gold} />
          </div>

          <section style={{ ...styles.card, marginBottom: 14 }}>
            <div style={styles.statementTitle}>Needs Attention</div>
            {attentionItems.length === 0 ? (
              <div style={{ ...styles.empty, padding: "10px 0", color: COLORS.green }}>All clear ✓ Nothing waiting on you.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {attentionItems.map((a, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, fontSize: 13 }}>
                    <span>{a.text}</span>
                    <button onClick={a.go} style={styles.confirmBtn}>
                      {a.action}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section style={{ ...styles.card, marginBottom: 14 }}>
            <div style={styles.statementTitle}>This Month</div>
            <StRow label="Sales (cash + credit)" value={dashboard.salesMonth} />
            <StRow label="Expenses" value={-dashboard.expensesMonth} />
            <StRow label="Sales less expenses" value={dashboard.salesMonth - dashboard.expensesMonth} total />
          </section>

          <section style={{ ...styles.card, marginBottom: 14 }}>
            <div style={styles.statementTitle}>Quick Actions</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[
                ["sale", "Record Sale"],
                ["expense", "Record Expense"],
                ["procurement", "Procurement"],
                ["stock", "Stock Movement"],
              ].map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => {
                    setRecordType(k);
                    setTab("record");
                  }}
                  style={{ ...styles.toggleBtn, flex: "1 0 45%" }}
                >
                  {l}
                </button>
              ))}
            </div>
          </section>

          <section style={styles.card}>
            <div style={styles.statementTitle}>Recent Activity</div>
            {transactions.length === 0 ? (
              <div style={styles.empty}>Nothing recorded yet. Start with a sale or an expense.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {transactions.slice(0, 6).map((t) => (
                  <div key={t.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, borderBottom: `1px solid ${COLORS.line}`, paddingBottom: 6 }}>
                    <span>
                      <span style={{ color: COLORS.muted }}>{fmtDate(new Date(t.date + "T00:00:00"))}</span> ·{" "}
                      {categoryLabel(categories, t.type, t.category)}
                    </span>
                    <span style={{ fontFamily: "'IBM Plex Mono', monospace", color: t.type === "income" ? COLORS.green : COLORS.rust }}>
                      {t.type === "income" ? "+" : "−"}
                      {naira(t.amount)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {loaded && tab === "record" && (
        <section style={styles.card}>
          <div style={{ ...styles.typeToggle, flexWrap: "wrap" }}>
            {[
              ["sale", "Sale"],
              ["expense", "Expense"],
              ["procurement", "Procurement"],
              ["stock", "Stock"],
              ["dispatch", "Delivery"],
            ].map(([k, l]) => (
              <button
                key={k}
                onClick={() => setRecordType(k)}
                style={{ ...styles.toggleBtn, flex: "1 0 30%", ...(recordType === k ? { background: COLORS.ink, color: "#fff" } : {}) }}
              >
                {l}
              </button>
            ))}
          </div>
          {recordType === "sale" && salesEntryJsx}
          {recordType === "expense" && expenseEntryJsx}
          {recordType === "procurement" && procurementEntryJsx}
          {recordType === "stock" && stockEntryJsx}
          {recordType === "dispatch" && dispatchEntryJsx}
        </section>
      )}

      {loaded && tab === "ledger" && (
        <section style={styles.card}>
          {booksNavJsx}
          <div style={{ ...styles.typeToggle, flexWrap: "wrap" }}>
            {[
              ["sales", "Sales Ledger"],
              ["expense", "Expense Ledger"],
              ["procurement", "Procurement Ledger"],
              ["cash", "Cash Ledger"],
              ["credit", "Credit Ledger"],
              ["budget", "Budget Ledger"],
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setLedgerSubTab(key)}
                style={{ ...styles.toggleBtn, flex: "1 0 30%", ...(ledgerSubTab === key ? { background: COLORS.ink, color: "#fff" } : {}) }}
              >
                {label}
              </button>
            ))}
          </div>

          <div style={styles.filterRow} className="no-print">
            {["day", "week", "month", "year"].map((m) => (
              <button
                key={m}
                onClick={() => setLedgerPeriodMode(m)}
                style={{
                  ...styles.toggleBtn,
                  flex: "none",
                  padding: "7px 12px",
                  fontSize: 12,
                  ...(ledgerPeriodMode === m ? { background: COLORS.ink, color: "#fff" } : {}),
                }}
              >
                {m[0].toUpperCase() + m.slice(1)}
              </button>
            ))}
            <input type="date" value={ledgerAnchor} onChange={(e) => setLedgerAnchor(e.target.value)} style={styles.filterInput} />
          </div>
          <div style={styles.reportLabel}>{ledgerRange.label}</div>

          {ledgerSubTab === "sales" && (
            <div>
              <button
                type="button"
                onClick={() => setShowSalesEntry((v) => !v)}
                style={{ ...styles.confirmBtn, width: "100%", marginBottom: 14, padding: "11px 0" }}
              >
                {showSalesEntry ? "Hide Sale Form" : "+ Record a Sale"}
              </button>
              {showSalesEntry && (
                <div style={{ ...styles.creditRow, marginBottom: 18 }}>{salesEntryJsx}</div>
              )}
              <div style={{ marginBottom: 14 }}>
                <StRow label="Cash Sales" value={salesLedgerTotals.cash} />
                <StRow label="Credit Sales" value={salesLedgerTotals.credit} />
                <StRow label="Total Sales" value={salesLedgerTotals.total} total />
              </div>
              {salesLedgerRows.length === 0 ? (
                <div style={styles.empty}>No sales recorded in this period.</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={styles.table}>
                    <thead>
                      <tr style={styles.theadRow}>
                        <th style={styles.th}>Date</th>
                        <th style={styles.th}>Source</th>
                        <th style={styles.th}>Category / Customer</th>
                        <th style={styles.th}>Status</th>
                        <th style={{ ...styles.th, textAlign: "right" }}>Amount</th>
                        <th style={styles.th} className="no-print"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {salesLedgerRows.map((r, i) => (
                        <tr key={r.id} style={{ background: i % 2 === 0 ? "transparent" : COLORS.rowAlt }}>
                          <td style={styles.td}>{fmtDate(new Date(r.date + "T00:00:00"))}</td>
                          <td style={{ ...styles.td, color: r.source === "Cash" ? COLORS.green : COLORS.gold, fontWeight: 700 }}>
                            {r.source}
                          </td>
                          <td style={styles.td}>{r.category}</td>
                          <td style={{ ...styles.td, color: r.status === "Outstanding" ? COLORS.rust : COLORS.muted }}>{r.status}</td>
                          <td style={{ ...styles.td, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{naira(r.amount)}</td>
                          <td style={styles.td} className="no-print">
                            <button onClick={() => generateInvoice(r.raw)} style={{ ...styles.cancelBtn, padding: "4px 10px" }}>
                              Invoice
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {ledgerSubTab === "expense" && (
            <div>
              <button
                type="button"
                onClick={() => setShowExpenseEntry((v) => !v)}
                style={{ ...styles.confirmBtn, width: "100%", marginBottom: 14, padding: "11px 0", background: COLORS.rust }}
              >
                {showExpenseEntry ? "Hide Expense Form" : "+ Record an Expense"}
              </button>
              {showExpenseEntry && (
                <div style={{ ...styles.creditRow, marginBottom: 18 }}>{expenseEntryJsx}</div>
              )}
              <div style={{ marginBottom: 14 }}>
                <StRow label="Total Expenses" value={expenseLedgerTotal} total />
              </div>
              {expenseLedgerRows.length === 0 ? (
                <div style={styles.empty}>No expenses recorded in this period.</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={styles.table}>
                    <thead>
                      <tr style={styles.theadRow}>
                        <th style={styles.th}>Date</th>
                        <th style={styles.th}>Category</th>
                        <th style={styles.th}>Description</th>
                        <th style={styles.th}>Method</th>
                        <th style={{ ...styles.th, textAlign: "right" }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {expenseLedgerRows.map((r, i) => (
                        <tr key={r.id} style={{ background: i % 2 === 0 ? "transparent" : COLORS.rowAlt }}>
                          <td style={styles.td}>{fmtDate(new Date(r.date + "T00:00:00"))}</td>
                          <td style={styles.td}>
                            {r.category}
                            {r.isProcurement && (
                              <span style={{ marginLeft: 6, fontSize: 10, color: COLORS.gold, fontWeight: 700 }}>PROCUREMENT</span>
                            )}
                          </td>
                          <td style={{ ...styles.td, color: COLORS.muted }}>{r.description || "—"}</td>
                          <td style={styles.td}>{r.method}</td>
                          <td style={{ ...styles.td, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: COLORS.rust }}>
                            {naira(r.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {ledgerSubTab === "procurement" && (
            <div>
              <button
                type="button"
                onClick={() => setShowProcEntry((v) => !v)}
                style={{ ...styles.confirmBtn, width: "100%", marginBottom: 14, padding: "11px 0", background: COLORS.rust }}
              >
                {showProcEntry ? "Hide Procurement Form" : "+ Record Procurement"}
              </button>
              {showProcEntry && (
                <div style={{ ...styles.creditRow, marginBottom: 18 }}>{procurementEntryJsx}</div>
              )}

              <div style={{ ...styles.statementTitle, marginTop: 24 }}>Procurement Records</div>
              <div style={{ marginBottom: 14 }}>
                <StRow label="Total Procurement" value={procurementLedgerTotal} total />
              </div>
              {procurementLedgerRows.length === 0 ? (
                <div style={styles.empty}>No procurement recorded in this period.</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={styles.table}>
                    <thead>
                      <tr style={styles.theadRow}>
                        <th style={styles.th}>Date</th>
                        <th style={styles.th}>Category</th>
                        <th style={styles.th}>Description</th>
                        <th style={styles.th}>Method</th>
                        <th style={{ ...styles.th, textAlign: "right" }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {procurementLedgerRows.map((r, i) => (
                        <tr key={r.id} style={{ background: i % 2 === 0 ? "transparent" : COLORS.rowAlt }}>
                          <td style={styles.td}>{fmtDate(new Date(r.date + "T00:00:00"))}</td>
                          <td style={styles.td}>{r.category}</td>
                          <td style={{ ...styles.td, color: COLORS.muted }}>{r.description || "—"}</td>
                          <td style={styles.td}>{r.method}</td>
                          <td style={{ ...styles.td, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: COLORS.rust }}>
                            {naira(r.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {ledgerSubTab === "cash" && (
            <div>
              <div style={{ marginBottom: 12 }}>
                <button onClick={applyLedgerPreset} style={styles.cancelBtn}>
                  Use {ledgerRange.label} as filter range
                </button>
              </div>
              <div style={styles.filterRow} className="no-print">
                <select value={filterType} onChange={(e) => setFilterType(e.target.value)} style={styles.filterInput}>
                  <option value="all">All</option>
                  <option value="income">Income only</option>
                  <option value="expense">Expense only</option>
                </select>
                <input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} style={styles.filterInput} />
                <span style={{ color: COLORS.muted, fontSize: 13 }}>to</span>
                <input type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} style={styles.filterInput} />
                <button onClick={exportBackup} style={styles.printBtn}>
                  Export Backup
                </button>
                <label style={{ ...styles.printBtn, display: "inline-block", cursor: "pointer" }}>
                  Import Backup
                  <input type="file" accept="application/json" onChange={importBackup} style={{ display: "none" }} />
                </label>
              </div>

              {filteredLedger.length === 0 ? (
                <div style={styles.empty}>No transactions recorded yet. Add one from the Sales or Record tab.</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={styles.table}>
                    <thead>
                      <tr style={styles.theadRow}>
                        <th style={styles.th}>Date</th>
                        <th style={styles.th}>Category</th>
                        <th style={styles.th}>Description</th>
                        <th style={styles.th}>Method</th>
                        <th style={{ ...styles.th, textAlign: "right" }}>Amount</th>
                        <th style={styles.th} className="no-print"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredLedger.map((t, i) => (
                        <tr key={t.id} style={{ background: i % 2 === 0 ? "transparent" : COLORS.rowAlt }}>
                          <td style={styles.td}>{fmtDate(new Date(t.date + "T00:00:00"))}</td>
                          <td style={styles.td}>{categoryLabel(categories, t.type, t.category)}</td>
                          <td style={{ ...styles.td, color: COLORS.muted }}>{t.description || "—"}</td>
                          <td style={styles.td}>{t.method}</td>
                          <td
                            style={{
                              ...styles.td,
                              textAlign: "right",
                              fontFamily: "'IBM Plex Mono', monospace",
                              color: t.type === "income" ? COLORS.green : COLORS.rust,
                            }}
                          >
                            {t.type === "income" ? "+" : "−"}
                            {naira(t.amount)}
                          </td>
                          <td style={styles.td} className="no-print">
                            <button onClick={() => deleteTransaction(t.id)} style={styles.deleteBtn} aria-label="Delete entry">
                              ✕
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {ledgerSubTab === "credit" && (
            <div>
              <div style={{ marginBottom: 14 }}>
                <StRow label="Total Credit Sales" value={creditLedgerTotals.total} />
                <StRow label="Outstanding" value={creditLedgerTotals.outstanding} />
                <StRow label="Collected" value={creditLedgerTotals.paid} total />
              </div>
              {creditLedgerRows.length === 0 ? (
                <div style={styles.empty}>No credit sales in this period.</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={styles.table}>
                    <thead>
                      <tr style={styles.theadRow}>
                        <th style={styles.th}>Date</th>
                        <th style={styles.th}>Customer</th>
                        <th style={styles.th}>Description</th>
                        <th style={styles.th}>Status</th>
                        <th style={{ ...styles.th, textAlign: "right" }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {creditLedgerRows.map((c, i) => (
                        <tr key={c.id} style={{ background: i % 2 === 0 ? "transparent" : COLORS.rowAlt }}>
                          <td style={styles.td}>{fmtDate(new Date(c.date + "T00:00:00"))}</td>
                          <td style={styles.td}>{c.customerName}</td>
                          <td style={{ ...styles.td, color: COLORS.muted }}>{c.description || "—"}</td>
                          <td style={{ ...styles.td, color: c.status === "outstanding" ? COLORS.rust : COLORS.green }}>
                            {c.status === "outstanding" ? "Outstanding" : "Paid"}
                          </td>
                          <td style={{ ...styles.td, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{naira(c.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {ledgerSubTab === "budget" && (
            <div>
              <div style={{ marginBottom: 14 }}>
                <StRow label="Requested" value={budgetLedgerTotals.requested} />
                <StRow label="Approved" value={budgetLedgerTotals.approved} />
                <StRow label="Retired (Paid)" value={budgetLedgerTotals.retired} total />
              </div>
              {budgetLedgerRows.length === 0 ? (
                <div style={styles.empty}>No budgets submitted in this period.</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={styles.table}>
                    <thead>
                      <tr style={styles.theadRow}>
                        <th style={styles.th}>Date</th>
                        <th style={styles.th}>Budget</th>
                        <th style={styles.th}>Item</th>
                        <th style={styles.th}>Status</th>
                        <th style={{ ...styles.th, textAlign: "right" }}>Requested</th>
                        <th style={{ ...styles.th, textAlign: "right" }}>Retired</th>
                      </tr>
                    </thead>
                    <tbody>
                      {budgetLedgerRows.map((r, i) => (
                        <tr key={r.id} style={{ background: i % 2 === 0 ? "transparent" : COLORS.rowAlt }}>
                          <td style={styles.td}>{fmtDate(new Date(r.date + "T00:00:00"))}</td>
                          <td style={styles.td}>{r.budgetTitle}</td>
                          <td style={{ ...styles.td, color: COLORS.muted }}>
                            {r.category} — {r.description}
                          </td>
                          <td
                            style={{
                              ...styles.td,
                              color: r.status === "approved" ? COLORS.green : r.status === "rejected" ? COLORS.rust : COLORS.muted,
                            }}
                          >
                            {r.status === "pending" ? "Pending" : r.status === "approved" ? "Approved" : "Rejected"}
                          </td>
                          <td style={{ ...styles.td, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{naira(r.requested)}</td>
                          <td style={{ ...styles.td, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace" }}>{naira(r.retired)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {loaded && tab === "stock" && (
        <section style={styles.card}>
          {booksNavJsx}
          {!selectedStockItem ? (
            <div>
              <div style={styles.statementTitle}>Add Stock Item</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
                <input
                  type="text"
                  placeholder="Item name — e.g. Beef, Goat Meat, Chicken"
                  value={newStockItemName}
                  onChange={(e) => setNewStockItemName(e.target.value)}
                  style={{ ...styles.input, flex: "1 1 200px" }}
                />
                <input
                  type="text"
                  placeholder="Unit (kg, pieces, crates…)"
                  value={newStockItemUnit}
                  onChange={(e) => setNewStockItemUnit(e.target.value)}
                  style={{ ...styles.input, flex: "1 1 140px" }}
                />
                <button type="button" onClick={addStockItem} style={styles.cancelBtn}>
                  + Add Item
                </button>
              </div>

              <div style={styles.statementTitle}>Stock Items</div>
              {stockItems.length === 0 ? (
                <div style={styles.empty}>No stock items yet. Add one above to start its Stock Book.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {stockItems.map((s) => {
                    const bal = stockBalances[s.id] || 0;
                    return (
                      <div key={s.id} style={styles.creditRow}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <button
                            onClick={() => setSelectedStockItem(s.id)}
                            style={{ background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer" }}
                          >
                            <span style={{ fontWeight: 700, color: COLORS.ink, fontSize: 15 }}>{s.name}</span>
                          </button>
                          <span
                            style={{
                              fontFamily: "'IBM Plex Mono', monospace",
                              fontWeight: 700,
                              color: bal < 0 ? COLORS.rust : COLORS.ink,
                            }}
                          >
                            {bal.toLocaleString()} {s.unit}
                          </span>
                        </div>
                        <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
                          <button onClick={() => setSelectedStockItem(s.id)} style={styles.confirmBtn}>
                            Open Book
                          </button>
                          <button onClick={() => deleteStockItem(s.id)} style={styles.deleteBtn}>
                            Delete Item
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div>
              {(() => {
                const item = stockItems.find((s) => s.id === selectedStockItem);
                const bal = stockBalances[selectedStockItem] || 0;
                return (
                  <div>
                    <button onClick={() => setSelectedStockItem(null)} style={{ ...styles.cancelBtn, marginBottom: 14 }}>
                      ← All Stock Items
                    </button>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 700 }}>{item ? item.name : ""}</div>
                      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 18, fontWeight: 700, color: bal < 0 ? COLORS.rust : COLORS.green }}>
                        {bal.toLocaleString()} {item ? item.unit : ""}
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 18 }}>Current Balance</div>

                    <div style={styles.statementTitle}>Record Movement</div>
                    <div style={styles.typeToggle}>
                      <button
                        onClick={() => setStockMoveForm((f) => ({ ...f, type: "in" }))}
                        style={{ ...styles.toggleBtn, ...(stockMoveForm.type === "in" ? { background: COLORS.green, color: "#fff" } : {}) }}
                      >
                        Goods In
                      </button>
                      <button
                        onClick={() => setStockMoveForm((f) => ({ ...f, type: "out" }))}
                        style={{ ...styles.toggleBtn, ...(stockMoveForm.type === "out" ? { background: COLORS.rust, color: "#fff" } : {}) }}
                      >
                        Goods Out
                      </button>
                    </div>
                    <div style={styles.form}>
                      <label style={styles.label}>
                        Date
                        <input
                          type="date"
                          value={stockMoveForm.date}
                          onChange={(e) => setStockMoveForm((f) => ({ ...f, date: e.target.value }))}
                          style={styles.input}
                        />
                      </label>
                      <label style={styles.label}>
                        Quantity {item ? `(${item.unit})` : ""}
                        <input
                          type="number"
                          min="0"
                          placeholder="0"
                          value={stockMoveForm.quantity}
                          onChange={(e) => setStockMoveForm((f) => ({ ...f, quantity: e.target.value }))}
                          style={{ ...styles.input, fontFamily: "'IBM Plex Mono', monospace" }}
                        />
                      </label>
                      <label style={styles.label}>
                        Note (optional)
                        <input
                          type="text"
                          placeholder="e.g. Delivery from supplier / Sold to customer"
                          value={stockMoveForm.note}
                          onChange={(e) => setStockMoveForm((f) => ({ ...f, note: e.target.value }))}
                          style={styles.input}
                        />
                      </label>
                      <label style={styles.label}>
                        Recorded By (optional)
                        <input
                          type="text"
                          placeholder="e.g. Chidi"
                          value={stockMoveForm.recordedBy}
                          onChange={(e) => setStockMoveForm((f) => ({ ...f, recordedBy: e.target.value }))}
                          style={styles.input}
                        />
                      </label>
                      <button type="button" onClick={() => addStockMovement()} style={styles.submitBtn}>
                        Record {stockMoveForm.type === "in" ? "Goods In" : "Goods Out"}
                      </button>
                    </div>

                    <div style={{ ...styles.statementTitle, marginTop: 24 }}>Stock Book</div>
                    {selectedStockMovements.length === 0 ? (
                      <div style={styles.empty}>No movements recorded yet for this item.</div>
                    ) : (
                      <div style={{ overflowX: "auto" }}>
                        <table style={styles.table}>
                          <thead>
                            <tr style={styles.theadRow}>
                              <th style={styles.th}>Date</th>
                              <th style={{ ...styles.th, textAlign: "right" }}>Goods In</th>
                              <th style={{ ...styles.th, textAlign: "right" }}>Goods Out</th>
                              <th style={{ ...styles.th, textAlign: "right" }}>Balance</th>
                              <th style={styles.th}>Note</th>
                              <th style={styles.th} className="no-print"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedStockMovements.map((m, i) => (
                              <tr key={m.id} style={{ background: i % 2 === 0 ? "transparent" : COLORS.rowAlt }}>
                                <td style={styles.td}>{fmtDate(new Date(m.date + "T00:00:00"))}</td>
                                <td style={{ ...styles.td, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: COLORS.green }}>
                                  {m.type === "in" ? m.quantity.toLocaleString() : ""}
                                </td>
                                <td style={{ ...styles.td, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", color: COLORS.rust }}>
                                  {m.type === "out" ? m.quantity.toLocaleString() : ""}
                                </td>
                                <td style={{ ...styles.td, textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700 }}>
                                  {m.balance.toLocaleString()}
                                </td>
                                <td style={{ ...styles.td, color: COLORS.muted }}>{m.note || "—"}</td>
                                <td style={styles.td} className="no-print">
                                  <button onClick={() => deleteStockMovement(m.id)} style={styles.deleteBtn} aria-label="Delete entry">
                                    ✕
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
        </section>
      )}

      {loaded && tab === "dispatch" && (
        <section style={styles.card}>
          {booksNavJsx}

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
            <StatCard label="Held for Vendors" value={naira(totalHeldForVendors)} color={COLORS.gold} />
            <StatCard
              label="Deliveries Pending"
              value={dispatches.filter((d) => d.status !== "delivered" && d.status !== "returned").length}
              color={COLORS.ink}
            />
          </div>

          <div style={styles.statementTitle}>Commission Payable</div>
          {workerCommissionSummary.filter((s) => s.deliveries > 0).length === 0 ? (
            <div style={styles.empty}>No commission earned yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
              {workerCommissionSummary
                .filter((s) => s.deliveries > 0)
                .map((s) => (
                  <div key={s.worker.id} style={styles.creditRow}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontWeight: 700 }}>
                        {s.worker.name} <span style={{ fontWeight: 400, color: COLORS.muted, fontSize: 12 }}>({s.role ? s.role.name : ""})</span>
                      </span>
                      <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{s.deliveries} deliveries</span>
                    </div>
                    <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 2 }}>
                      Earned {naira(s.earned)} · Unpaid {naira(s.unpaid)}
                    </div>
                    {s.unpaid > 0 && (
                      <div style={{ marginTop: 8 }}>
                        {commissionPayDraft.workerId === s.worker.id ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            <input
                              type="date"
                              value={commissionPayDraft.date}
                              onChange={(e) => setCommissionPayDraft((d) => ({ ...d, date: e.target.value }))}
                              style={styles.filterInput}
                            />
                            <select
                              value={commissionPayDraft.method}
                              onChange={(e) => setCommissionPayDraft((d) => ({ ...d, method: e.target.value }))}
                              style={styles.filterInput}
                            >
                              {PAYMENT_METHODS.map((m) => (
                                <option key={m} value={m}>
                                  {m}
                                </option>
                              ))}
                            </select>
                            <div style={{ display: "flex", gap: 8 }}>
                              <button onClick={() => payWorkerCommission(s.worker.id)} style={styles.confirmBtn}>
                                Confirm Payment
                              </button>
                              <button onClick={() => setCommissionPayDraft({ workerId: null, date: todayStr(), method: "Cash" })} style={styles.cancelBtn}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => setCommissionPayDraft({ workerId: s.worker.id, date: todayStr(), method: "Cash" })}
                            style={styles.confirmBtn}
                          >
                            Pay Commission
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
            </div>
          )}

          <div style={styles.statementTitle}>Deliveries</div>
          <div style={{ ...styles.filterRow, marginBottom: 14 }} className="no-print">
            <select value={dispatchFilter} onChange={(e) => setDispatchFilter(e.target.value)} style={styles.filterInput}>
              <option value="all">All</option>
              <option value="yet_to_deliver">Yet to be Delivered</option>
              <option value="on_transit">On Transit</option>
              <option value="delivered">Delivered</option>
              <option value="returned">Returned</option>
            </select>
          </div>

          {dispatches.filter((d) => dispatchFilter === "all" || d.status === dispatchFilter).length === 0 ? (
            <div style={styles.empty}>No deliveries logged yet. Add one from Record → Delivery.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {dispatches
                .filter((d) => dispatchFilter === "all" || d.status === dispatchFilter)
                .map((d) => {
                  const statusInfo = DELIVERY_STATUSES.find((s) => s.id === d.status);
                  const dispatcher = workers.find((w) => w.id === d.dispatcherId);
                  const bdo = workers.find((w) => w.id === d.bdoId);
                  return (
                    <div key={d.id} style={styles.creditRow}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ fontWeight: 700 }}>{d.productName || d.destination || "Delivery"}</span>
                        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700 }}>{naira(d.deliveryAmount)}</span>
                      </div>
                      <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 2 }}>
                        {fmtDate(new Date(d.date + "T00:00:00"))}
                        {d.vendorName ? ` · ${d.vendorName}` : ""}
                        {d.destination ? ` · to ${d.destination}` : ""}
                        {d.receiverPhone ? ` · ${d.receiverPhone}` : ""}
                      </div>
                      <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 2 }}>
                        {dispatcher ? `Dispatcher: ${dispatcher.name}` : ""}
                        {bdo ? `${dispatcher ? " · " : ""}BDO: ${bdo.name}` : ""}
                      </div>
                      {d.productAmount > 0 && (
                        <div style={{ fontSize: 12, color: COLORS.gold, marginTop: 4 }}>
                          COD collected: {naira(d.productAmount)}
                          {d.status === "delivered" && d.vendorOwed > 0 && ` · Owed to vendor: ${naira(d.vendorOwed)}`}
                        </div>
                      )}

                      <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        {d.status === "delivered" ? (
                          <span style={{ fontSize: 12, fontWeight: 700, color: COLORS.green }}>✓ Delivered</span>
                        ) : (
                          <select
                            value={d.status}
                            onChange={(e) => updateDispatchStatus(d.id, e.target.value)}
                            style={styles.filterInput}
                          >
                            {DELIVERY_STATUSES.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.label}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>

                      {d.status === "delivered" && d.vendorRemitStatus === "pending" && (
                        <div style={{ marginTop: 8 }}>
                          {remitDraft.id === d.id ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              <input
                                type="date"
                                value={remitDraft.date}
                                onChange={(e) => setRemitDraft((r) => ({ ...r, date: e.target.value }))}
                                style={styles.filterInput}
                              />
                              <select
                                value={remitDraft.method}
                                onChange={(e) => setRemitDraft((r) => ({ ...r, method: e.target.value }))}
                                style={styles.filterInput}
                              >
                                {PAYMENT_METHODS.map((m) => (
                                  <option key={m} value={m}>
                                    {m}
                                  </option>
                                ))}
                              </select>
                              <div style={{ display: "flex", gap: 8 }}>
                                <button onClick={confirmVendorRemit} style={styles.confirmBtn}>
                                  Confirm Remittance
                                </button>
                                <button onClick={() => setRemitDraft({ id: null, date: todayStr(), method: "Cash" })} style={styles.cancelBtn}>
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button onClick={() => setRemitDraft({ id: d.id, date: todayStr(), method: "Cash" })} style={styles.confirmBtn}>
                              Remit to Vendor ({naira(d.vendorOwed)})
                            </button>
                          )}
                        </div>
                      )}
                      {d.status === "delivered" && d.vendorRemitStatus === "remitted" && (
                        <div style={{ fontSize: 12, color: COLORS.green, marginTop: 6 }}>
                          ✓ Remitted {fmtDate(new Date(d.vendorRemitDate + "T00:00:00"))} via {d.vendorRemitMethod}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </section>
      )}

      {loaded && tab === "credit" && (
        <section style={styles.card}>
          {booksNavJsx}
          <div style={styles.statementTitle}>Supply on Credit</div>
          <div style={styles.form}>
            <label style={styles.label}>
              Customer Name
              <input
                type="text"
                placeholder="e.g. Mrs. Okafor"
                value={creditForm.customerName}
                onChange={(e) => setCreditForm((f) => ({ ...f, customerName: e.target.value }))}
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              Date Supplied
              <input
                type="date"
                value={creditForm.date}
                onChange={(e) => setCreditForm((f) => ({ ...f, date: e.target.value }))}
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              Category
              <select
                value={creditForm.category}
                onChange={(e) => setCreditForm((f) => ({ ...f, category: e.target.value }))}
                style={styles.input}
              >
                {categories.income.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={styles.label}>
              What was supplied
              <input
                type="text"
                placeholder="e.g. 20kg beef"
                value={creditForm.description}
                onChange={(e) => setCreditForm((f) => ({ ...f, description: e.target.value }))}
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              Amount Owed (₦)
              <input
                type="number"
                min="0"
                step="1"
                placeholder="0"
                value={creditForm.amount}
                onChange={(e) => setCreditForm((f) => ({ ...f, amount: e.target.value }))}
                style={{ ...styles.input, fontFamily: "'IBM Plex Mono', monospace" }}
              />
            </label>
            <label style={styles.label}>
              Expected Payment Date (optional)
              <input
                type="date"
                value={creditForm.dueDate}
                onChange={(e) => setCreditForm((f) => ({ ...f, dueDate: e.target.value }))}
                style={styles.input}
              />
            </label>
            <button type="button" onClick={addCreditSale} style={styles.submitBtn}>
              Record Credit Supply
            </button>
          </div>

          {creditNote && (
            <div style={{ ...styles.creditRow, marginTop: 16, borderColor: COLORS.green, color: COLORS.green, fontSize: 13, fontWeight: 700 }}>
              {creditNote}
            </div>
          )}
          <div style={{ ...styles.statementTitle, marginTop: 22 }}>Customer Credit List</div>
          <div style={styles.hintNote}>
            These two buttons only switch the list you're viewing. To settle a customer, open Outstanding and tap Mark Paid on their record.
          </div>
          <div style={{ ...styles.typeToggle, marginTop: 10 }}>
            <button
              onClick={() => setCreditView("outstanding")}
              style={{ ...styles.toggleBtn, ...(creditView === "outstanding" ? { background: COLORS.ink, color: "#fff" } : {}) }}
            >
              Show Outstanding ({creditSales.filter((c) => c.status === "outstanding").length})
            </button>
            <button
              onClick={() => setCreditView("paid")}
              style={{ ...styles.toggleBtn, ...(creditView === "paid" ? { background: COLORS.ink, color: "#fff" } : {}) }}
            >
              Show Settled ({creditSales.filter((c) => c.status === "paid").length})
            </button>
          </div>

          {creditSales.filter((c) => c.status === creditView).length === 0 ? (
            <div style={styles.empty}>
              {creditView === "outstanding" ? "No outstanding credit right now." : "No settled credit entries yet."}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {creditSales
                .filter((c) => c.status === creditView)
                .map((c) => (
                  <div key={c.id} style={styles.creditRow}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontWeight: 700 }}>{c.customerName}</span>
                      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700 }}>{naira(c.amount)}</span>
                    </div>
                    <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 2 }}>
                      Supplied {fmtDate(new Date(c.date + "T00:00:00"))}
                      {c.description ? ` — ${c.description}` : ""}
                      {c.dueDate ? ` · Due ${fmtDate(new Date(c.dueDate + "T00:00:00"))}` : ""}
                    </div>
                    {c.status === "paid" && (
                      <div style={{ fontSize: 12, color: COLORS.green, marginTop: 2 }}>
                        Paid {fmtDate(new Date(c.paidDate + "T00:00:00"))} via {c.paidMethod}
                      </div>
                    )}
                    {c.status === "outstanding" && (
                      <div style={{ marginTop: 8 }} className="no-print">
                        {payingId === c.id ? (
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                            <input
                              type="date"
                              value={payDraft.date}
                              onChange={(e) => setPayDraft((d) => ({ ...d, date: e.target.value }))}
                              style={styles.filterInput}
                            />
                            <select
                              value={payDraft.method}
                              onChange={(e) => setPayDraft((d) => ({ ...d, method: e.target.value }))}
                              style={styles.filterInput}
                            >
                              {PAYMENT_METHODS.map((m) => (
                                <option key={m} value={m}>
                                  {m}
                                </option>
                              ))}
                            </select>
                            <button onClick={() => confirmPayment(c)} style={styles.confirmBtn}>
                              Confirm Payment
                            </button>
                            <button onClick={() => setPayingId(null)} style={styles.cancelBtn}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: "flex", gap: 8 }}>
                            <button onClick={() => startPayment(c.id)} style={styles.confirmBtn}>
                              Mark Paid (Customer Has Paid)
                            </button>
                            <button onClick={() => deleteCreditSale(c.id)} style={styles.deleteBtn}>
                              Remove
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
            </div>
          )}
        </section>
      )}

      {loaded && tab === "budgets" && (
        <section style={styles.card}>
          <div style={styles.hintNote}>
            The Approver PIN below is a soft control, not real security — anyone using this device can see and reset
            it. It's meant to slow down and log spending decisions, not to lock people out.
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 10, marginBottom: 18, flexWrap: "wrap" }}>
            <label style={{ ...styles.label, flex: 1, minWidth: 160 }}>
              {settings.approverPin ? "Change Approver PIN" : "Set Approver PIN"}
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                name="meatshare-approver-pin-setup"
                placeholder="4+ digit PIN"
                value={pinSetupDraft}
                onChange={(e) => setPinSetupDraft(e.target.value.trim())}
                style={styles.input}
              />
            </label>
            <button type="button" onClick={savePin} style={{ ...styles.confirmBtn, padding: "10px 16px" }}>
              Save PIN
            </button>
          </div>
          {!settings.approverPin && (
            <div style={{ ...styles.hintNote, marginTop: -12, marginBottom: 16 }}>
              No PIN set yet — set one above before approving or rejecting budget items.
            </div>
          )}

          <div style={{ ...styles.typeToggle, flexWrap: "wrap" }}>
            {[
              ["new", "New Budget"],
              ["review", `Review${pendingList.length ? ` (${pendingList.length})` : ""}`],
              ["retire", `Retire${approvedAwaitingRetire.length ? ` (${approvedAwaitingRetire.length})` : ""}`],
              ["history", "History"],
              ["log", "Log Trail"],
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setBudgetSubTab(key)}
                style={{ ...styles.toggleBtn, flex: "1 0 30%", ...(budgetSubTab === key ? { background: COLORS.ink, color: "#fff" } : {}) }}
              >
                {label}
              </button>
            ))}
          </div>

          {budgetSubTab === "new" && (
            <div>
              <div style={styles.statementTitle}>Budget Details</div>
              <div style={styles.form}>
                <label style={styles.label}>
                  Budget Title / Period
                  <input
                    type="text"
                    placeholder="e.g. August 2026 Operations"
                    value={budgetTitle}
                    onChange={(e) => setBudgetTitle(e.target.value)}
                    style={styles.input}
                  />
                </label>
                <label style={styles.label}>
                  Prepared By (Accountant)
                  <input
                    type="text"
                    placeholder="e.g. Ifeoma"
                    value={budgetAccountant}
                    onChange={(e) => setBudgetAccountant(e.target.value)}
                    style={styles.input}
                  />
                </label>
              </div>

              <div style={{ ...styles.statementTitle, marginTop: 20 }}>Add Line Item</div>
              <div style={styles.form}>
                <label style={styles.label}>
                  Category
                  <select
                    value={budgetItemDraft.category}
                    onChange={(e) => setBudgetItemDraft((d) => ({ ...d, category: e.target.value }))}
                    style={styles.input}
                  >
                    {categories.expense.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={styles.label}>
                  Description
                  <input
                    type="text"
                    placeholder="e.g. Fuel for delivery van, 4 weeks"
                    value={budgetItemDraft.description}
                    onChange={(e) => setBudgetItemDraft((d) => ({ ...d, description: e.target.value }))}
                    style={styles.input}
                  />
                </label>
                <label style={styles.label}>
                  Amount (₦)
                  <input
                    type="number"
                    min="0"
                    placeholder="0"
                    value={budgetItemDraft.amount}
                    onChange={(e) => setBudgetItemDraft((d) => ({ ...d, amount: e.target.value }))}
                    style={{ ...styles.input, fontFamily: "'IBM Plex Mono', monospace" }}
                  />
                </label>
                <button type="button" onClick={addDraftItem} style={styles.cancelBtn}>
                  + Add Item to Budget
                </button>
              </div>

              {draftItems.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={styles.statementTitle}>Items in This Budget</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {draftItems.map((it) => (
                      <div key={it.id} style={styles.creditRow}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span>
                            {categoryLabel(categories, "expense", it.category)} — {it.description}
                          </span>
                          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700 }}>{naira(it.amountRequested)}</span>
                        </div>
                        <button onClick={() => removeDraftItem(it.id)} style={{ ...styles.deleteBtn, marginTop: 4 }}>
                          Remove
                        </button>
                      </div>
                    ))}
                    <StRow label="Total Requested" value={draftItems.reduce((s, i) => s + i.amountRequested, 0)} total />
                  </div>
                  <button type="button" onClick={submitBudget} style={{ ...styles.submitBtn, marginTop: 12 }}>
                    Submit Budget for Approval
                  </button>
                </div>
              )}
            </div>
          )}

          {budgetSubTab === "review" && (
            <div>
              {pendingList.length === 0 ? (
                <div style={styles.empty}>Nothing waiting on a decision.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {pendingList.map(({ budget, item }) => {
                    const key = `${budget.id}::${item.id}`;
                    return (
                      <div key={key} style={styles.creditRow}>
                        <div style={{ fontSize: 11, color: COLORS.gold, fontWeight: 700, letterSpacing: "0.05em" }}>
                          {budget.title.toUpperCase()}
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                          <span style={{ fontWeight: 700 }}>{categoryLabel(categories, "expense", item.category)}</span>
                          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, color: COLORS.rust }}>
                            {naira(item.amountRequested)}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 2 }}>
                          {item.description}
                          {budget.accountant ? ` · Requested by ${budget.accountant}` : ""}
                        </div>
                        <div style={{ marginTop: 8 }}>
                          {itemDecisionId === key ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              <input
                                type="text"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                autoComplete="off"
                                name="meatshare-decision-pin"
                                placeholder="Approver PIN"
                                value={itemDecisionDraft.pin}
                                onChange={(e) => setItemDecisionDraft((d) => ({ ...d, pin: e.target.value.trim() }))}
                                style={styles.filterInput}
                              />
                              <input
                                type="text"
                                placeholder="Reason (required if rejecting)"
                                value={itemDecisionDraft.reason}
                                onChange={(e) => setItemDecisionDraft((d) => ({ ...d, reason: e.target.value }))}
                                style={styles.filterInput}
                              />
                              {pinError && <div style={{ fontSize: 12, color: COLORS.rust }}>{pinError}</div>}
                              <div style={{ display: "flex", gap: 8 }}>
                                <button onClick={() => decideItem(budget, item, "approved")} style={styles.confirmBtn}>
                                  Approve
                                </button>
                                <button onClick={() => decideItem(budget, item, "rejected")} style={styles.cancelBtn}>
                                  Reject
                                </button>
                                <button onClick={() => setItemDecisionId(null)} style={styles.cancelBtn}>
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button onClick={() => startItemDecision(budget.id, item.id)} style={styles.confirmBtn}>
                              Review
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <StRow label="Total Pending Decision" value={pendingTotal} total />
                </div>
              )}
            </div>
          )}

          {budgetSubTab === "retire" && (
            <div>
              {approvedAwaitingRetire.length === 0 ? (
                <div style={styles.empty}>Nothing approved is waiting on payment right now.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {approvedAwaitingRetire.map(({ budget, item, retired, remaining }) => {
                    const key = `${budget.id}::${item.id}`;
                    return (
                      <div key={key} style={styles.creditRow}>
                        <div style={{ fontSize: 11, color: COLORS.gold, fontWeight: 700, letterSpacing: "0.05em" }}>
                          {budget.title.toUpperCase()}
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                          <span style={{ fontWeight: 700 }}>{categoryLabel(categories, "expense", item.category)}</span>
                          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700 }}>{naira(item.amountRequested)}</span>
                        </div>
                        <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 2 }}>{item.description}</div>
                        <div style={{ fontSize: 12, color: COLORS.green, marginTop: 4 }}>
                          Retired so far: {naira(retired)} · Remaining: {naira(remaining)}
                        </div>
                        <div style={{ marginTop: 8 }}>
                          {retireId === key ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              <input
                                type="date"
                                value={retireDraft.date}
                                onChange={(e) => setRetireDraft((d) => ({ ...d, date: e.target.value }))}
                                style={styles.filterInput}
                              />
                              <input
                                type="number"
                                min="0"
                                placeholder="Amount paid (₦)"
                                value={retireDraft.amount}
                                onChange={(e) => setRetireDraft((d) => ({ ...d, amount: e.target.value }))}
                                style={{ ...styles.filterInput, fontFamily: "'IBM Plex Mono', monospace" }}
                              />
                              <select
                                value={retireDraft.method}
                                onChange={(e) => setRetireDraft((d) => ({ ...d, method: e.target.value }))}
                                style={styles.filterInput}
                              >
                                {PAYMENT_METHODS.map((m) => (
                                  <option key={m} value={m}>
                                    {m}
                                  </option>
                                ))}
                              </select>
                              <input
                                type="text"
                                placeholder="Payment reference / note"
                                value={retireDraft.note}
                                onChange={(e) => setRetireDraft((d) => ({ ...d, note: e.target.value }))}
                                style={styles.filterInput}
                              />
                              <input
                                type="text"
                                placeholder="Recorded by (accountant)"
                                value={retireDraft.recordedBy}
                                onChange={(e) => setRetireDraft((d) => ({ ...d, recordedBy: e.target.value }))}
                                style={styles.filterInput}
                              />
                              {pinError && <div style={{ fontSize: 12, color: COLORS.rust }}>{pinError}</div>}
                              <div style={{ display: "flex", gap: 8 }}>
                                <button onClick={() => retirePayment(budget, item)} style={styles.confirmBtn}>
                                  Confirm Retirement
                                </button>
                                <button
                                  onClick={() => {
                                    setRetireId(null);
                                    setPinError("");
                                  }}
                                  style={styles.cancelBtn}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button onClick={() => startRetire(budget.id, item.id, remaining)} style={styles.confirmBtn}>
                              Retire Payment
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {budgetSubTab === "history" && (
            <div>
              {budgets.length === 0 ? (
                <div style={styles.empty}>No budgets submitted yet.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {budgets.map((b) => {
                    const total = b.items.reduce((s, i) => s + i.amountRequested, 0);
                    const approvedTotal = b.items.filter((i) => i.status === "approved").reduce((s, i) => s + i.amountRequested, 0);
                    const retiredTotal = b.items.reduce((s, i) => s + i.retirements.reduce((s2, r) => s2 + r.amount, 0), 0);
                    return (
                      <div key={b.id} style={styles.creditRow}>
                        <div style={{ fontWeight: 700 }}>{b.title}</div>
                        <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 6 }}>
                          {fmtDate(new Date(b.createdAt))}
                          {b.accountant ? ` · Prepared by ${b.accountant}` : ""}
                        </div>
                        {b.items.map((i) => {
                          const retired = i.retirements.reduce((s, r) => s + r.amount, 0);
                          const variance = i.amountRequested - retired;
                          return (
                            <div key={i.id} style={{ fontSize: 13, padding: "4px 0", borderTop: `1px solid ${COLORS.line}` }}>
                              <div style={{ display: "flex", justifyContent: "space-between" }}>
                                <span>
                                  {categoryLabel(categories, "expense", i.category)} — {i.description}
                                </span>
                                <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{naira(i.amountRequested)}</span>
                              </div>
                              <div
                                style={{
                                  fontSize: 11,
                                  color:
                                    i.status === "approved" ? COLORS.green : i.status === "rejected" ? COLORS.rust : COLORS.muted,
                                }}
                              >
                                {i.status === "pending" ? "Awaiting decision" : i.status === "approved" ? `Approved` : `Rejected`}
                                {i.status === "rejected" && i.rejectReason ? ` — ${i.rejectReason}` : ""}
                                {i.status === "approved" ? ` · Retired ${naira(retired)} of ${naira(i.amountRequested)}` : ""}
                              </div>
                              {i.status === "approved" && (
                                <div
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 700,
                                    color: variance >= 0 ? COLORS.green : COLORS.rust,
                                    marginTop: 2,
                                  }}
                                >
                                  {variance >= 0
                                    ? `Surplus: ${naira(variance)} remaining`
                                    : `Deficit: ${naira(Math.abs(variance))} over budget`}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        <div style={{ marginTop: 8 }}>
                          <StRow label="Requested" value={total} />
                          <StRow label="Approved" value={approvedTotal} />
                          <StRow label="Retired (paid)" value={retiredTotal} subtotal />
                          <StRow
                            label={approvedTotal - retiredTotal >= 0 ? "Surplus (unspent)" : "Deficit (overspent)"}
                            value={approvedTotal - retiredTotal}
                            total
                            highlight={approvedTotal - retiredTotal >= 0 ? COLORS.green : COLORS.rust}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {budgetSubTab === "log" && (
            <div>
              {logTrail.length === 0 ? (
                <div style={styles.empty}>No governance activity logged yet.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {logTrail.map((l) => (
                    <div key={l.id} style={{ fontSize: 12, borderBottom: `1px solid ${COLORS.line}`, paddingBottom: 6 }}>
                      <div style={{ color: COLORS.muted }}>
                        {new Date(l.timestamp).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                        {" · "}
                        <span style={{ fontWeight: 700, color: COLORS.ink }}>{l.action}</span>
                      </div>
                      <div>{l.detail}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {loaded && tab === "reports" && (
        <section style={styles.card}>
          <div style={styles.filterRow} className="no-print">
            <div style={styles.typeToggle}>
              <button onClick={() => setPeriodMode("day")} style={{ ...styles.toggleBtn, ...(periodMode === "day" ? { background: COLORS.ink, color: "#fff" } : {}) }}>Daily</button>
              <button
                onClick={() => setPeriodMode("week")}
                style={{ ...styles.toggleBtn, ...(periodMode === "week" ? { background: COLORS.ink, color: "#fff" } : {}) }}
              >
                Weekly
              </button>
              <button
                onClick={() => setPeriodMode("month")}
                style={{ ...styles.toggleBtn, ...(periodMode === "month" ? { background: COLORS.ink, color: "#fff" } : {}) }}
              >
                Monthly
              </button>
              <button onClick={() => setPeriodMode("year")} style={{ ...styles.toggleBtn, ...(periodMode === "year" ? { background: COLORS.ink, color: "#fff" } : {}) }}>Yearly</button>
            </div>
            {periodMode === "day" ? (
              <input type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} style={styles.filterInput} />
            ) : periodMode === "week" ? (
              <input type="date" value={weekAnchor} onChange={(e) => setWeekAnchor(e.target.value)} style={styles.filterInput} />
            ) : periodMode === "month" ? (
              <input type="month" value={monthValue} onChange={(e) => setMonthValue(e.target.value)} style={styles.filterInput} />
            ) : (
              <input type="number" min="2000" max="2100" value={reportYear} onChange={(e) => setReportYear(e.target.value)} style={styles.filterInput} />
            )}
            <button onClick={() => window.print()} style={styles.printBtn}>
              Print
            </button>
            <button onClick={generateInvestorSnapshot} style={{ ...styles.printBtn, borderColor: COLORS.gold, color: COLORS.gold }}>
              Investor Snapshot
            </button>
          </div>

          <div style={styles.reportLabel}>{reportRange.label}</div>

          <div style={styles.statementBlock}>
            <div style={styles.statementTitle}>Trading Account</div>
            <StRow label="Sales Revenue (bookings + direct sales)" value={statement.sales} bold />
            <div style={styles.statementSubhead}>Less: Cost of Goods Sold</div>
            {statement.cogsByCategory.map((c) => (
              <StRow key={c.id} label={c.label} value={-c.amount} indent />
            ))}
            <StRow label="Total Cost of Goods Sold" value={-statement.totalCogs} subtotal />
            <StRow label="Gross Profit" value={statement.grossProfit} total />
          </div>

          <div style={styles.statementBlock}>
            <div style={styles.statementTitle}>Income Statement (Profit &amp; Loss)</div>
            <StRow label="Gross Profit (from Trading Account)" value={statement.grossProfit} />
            <StRow label="Other Income" value={statement.otherIncome} />
            <div style={styles.statementSubhead}>Less: Operating Expenses</div>
            {statement.opexByCategory.map((c) => (
              <StRow key={c.id} label={c.label} value={-c.amount} indent />
            ))}
            <StRow label="Total Operating Expenses" value={-statement.totalOpex} subtotal />
            <StRow
              label="Net Profit"
              value={statement.netProfit}
              total
              highlight={statement.netProfit >= 0 ? COLORS.green : COLORS.rust}
            />
          </div>

          {reportTx.length === 0 && <div style={styles.empty}>No transactions fall in this period yet.</div>}
        </section>
      )}

      {loaded && tab === "settings" && (
        <section style={styles.card}>
          <div style={styles.statementTitle}>Business Details</div>
          <div style={styles.hintNote}>
            This is the name and contact info that appears at the top of this app and on every invoice you send out.
          </div>
          <div style={{ ...styles.form, marginTop: 10, marginBottom: 26 }}>
            <label style={styles.label}>
              Business Name
              <input
                type="text"
                placeholder="e.g. Acme Meats Ltd"
                value={profileDraft.name}
                onChange={(e) => setProfileDraft((d) => ({ ...d, name: e.target.value }))}
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              Phone (shown on invoices)
              <input
                type="tel"
                placeholder="e.g. 08012345678"
                value={profileDraft.phone}
                onChange={(e) => setProfileDraft((d) => ({ ...d, phone: e.target.value }))}
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              Address (shown on invoices)
              <input
                type="text"
                placeholder="e.g. 12 Market Road, Awka"
                value={profileDraft.address}
                onChange={(e) => setProfileDraft((d) => ({ ...d, address: e.target.value }))}
                style={styles.input}
              />
            </label>
            <label style={styles.label}>
              Invoice Footer Note (optional)
              <input
                type="text"
                placeholder="e.g. Payments to Acme Meats, GTB 0123456789"
                value={profileDraft.note}
                onChange={(e) => setProfileDraft((d) => ({ ...d, note: e.target.value }))}
                style={styles.input}
              />
            </label>
            <button type="button" onClick={saveBusinessProfile} style={styles.submitBtn}>
              {profileSaved ? "Saved ✓" : "Save Business Details"}
            </button>
          </div>

          <div style={styles.statementTitle}>Categories</div>
          <div style={styles.hintNote}>
            These categories shape every dropdown, the Trading Account, and the P&L. Set them up to match how this
            business actually talks about its sales and spending — they don't have to match any other business using
            this tool.
          </div>

          <div style={{ ...styles.statementTitle, marginTop: 16 }}>Income Categories</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
            {categories.income.map((c) => (
              <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="text"
                  value={c.label}
                  onChange={(e) => renameCategory("income", c.id, e.target.value)}
                  style={{ ...styles.input, flex: 1 }}
                />
                <button onClick={() => removeCategory("income", c.id)} style={styles.deleteBtn}>
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              placeholder="New income category — e.g. Catering Orders"
              value={newIncomeCat}
              onChange={(e) => setNewIncomeCat(e.target.value)}
              style={{ ...styles.input, flex: 1 }}
            />
            <button type="button" onClick={addIncomeCategory} style={styles.cancelBtn}>
              + Add
            </button>
          </div>

          <div style={{ ...styles.statementTitle, marginTop: 26 }}>Expense Categories</div>
          <div style={styles.hintNote}>
            Tick "COGS" for costs directly tied to producing what you sell (stock, raw materials, production) — these
            get subtracted in the Trading Account to give Gross Profit. Leave it unticked for operating costs
            (rent, salaries, marketing) — these come out further down, in the P&L.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0" }}>
            {categories.expense.map((c) => (
              <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="text"
                  value={c.label}
                  onChange={(e) => renameCategory("expense", c.id, e.target.value)}
                  style={{ ...styles.input, flex: 1 }}
                />
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: COLORS.muted, whiteSpace: "nowrap" }}>
                  <input type="checkbox" checked={!!c.cogs} onChange={() => toggleCategoryCogs(c.id)} />
                  COGS
                </label>
                <button onClick={() => removeCategory("expense", c.id)} style={styles.deleteBtn}>
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              type="text"
              placeholder="New expense category — e.g. Equipment Repairs"
              value={newExpenseCat}
              onChange={(e) => setNewExpenseCat(e.target.value)}
              style={{ ...styles.input, flex: "1 1 200px" }}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: COLORS.muted }}>
              <input type="checkbox" checked={newExpenseCatCogs} onChange={(e) => setNewExpenseCatCogs(e.target.checked)} />
              COGS
            </label>
            <button type="button" onClick={addExpenseCategory} style={styles.cancelBtn}>
              + Add
            </button>
          </div>

          <div style={{ ...styles.statementTitle, marginTop: 26 }}>Roles & Commission</div>
          <div style={styles.hintNote}>
            Set how each role earns commission. Change the rate here any time — it applies to new deliveries right
            away, without touching past records.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, margin: "12px 0" }}>
            {roles.map((r) => (
              <div key={r.id} style={styles.creditRow}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <input
                    type="text"
                    value={r.name}
                    onChange={(e) => updateRole(r.id, { name: e.target.value })}
                    style={{ ...styles.input, flex: 1 }}
                  />
                  <button onClick={() => removeRole(r.id)} style={styles.deleteBtn}>
                    ✕
                  </button>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <select
                    value={r.commissionType}
                    onChange={(e) => updateRole(r.id, { commissionType: e.target.value })}
                    style={{ ...styles.input, flex: 1 }}
                  >
                    <option value="flat">Flat per delivery (₦)</option>
                    <option value="percent">Percent of service charge (%)</option>
                  </select>
                  <input
                    type="number"
                    min="0"
                    value={r.rate}
                    onChange={(e) => updateRole(r.id, { rate: parseFloat(e.target.value) || 0 })}
                    style={{ ...styles.input, width: 90, fontFamily: "'IBM Plex Mono', monospace" }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              placeholder="New role — e.g. Rider, Agent"
              value={newRoleName}
              onChange={(e) => setNewRoleName(e.target.value)}
              style={{ ...styles.input, flex: 1 }}
            />
            <button type="button" onClick={addRole} style={styles.cancelBtn}>
              + Add Role
            </button>
          </div>

          <div style={{ ...styles.statementTitle, marginTop: 26 }}>Workers</div>
          <div style={styles.hintNote}>Dispatchers, BDOs, riders — anyone assigned to a delivery and paid commission.</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0" }}>
            {workers.length === 0 ? (
              <div style={styles.empty}>No workers added yet.</div>
            ) : (
              workers.map((w) => {
                const role = roles.find((r) => r.id === w.roleId);
                return (
                  <div key={w.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, borderBottom: `1px solid ${COLORS.line}`, paddingBottom: 6 }}>
                    <span>
                      {w.name} — {role ? role.name : "—"}
                      {w.phone ? ` · ${w.phone}` : ""}
                    </span>
                    <button onClick={() => removeWorker(w.id)} style={styles.deleteBtn}>
                      Remove
                    </button>
                  </div>
                );
              })
            )}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              type="text"
              placeholder="Worker name"
              value={newWorkerName}
              onChange={(e) => setNewWorkerName(e.target.value)}
              style={{ ...styles.input, flex: "1 1 140px" }}
            />
            <input
              type="tel"
              placeholder="Phone (optional)"
              value={newWorkerPhone}
              onChange={(e) => setNewWorkerPhone(e.target.value)}
              style={{ ...styles.input, flex: "1 1 120px" }}
            />
            <select value={newWorkerRole} onChange={(e) => setNewWorkerRole(e.target.value)} style={{ ...styles.input, flex: "1 1 120px" }}>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <button type="button" onClick={addWorker} style={styles.cancelBtn}>
              + Add Worker
            </button>
          </div>
        </section>
      )}

      {invoiceView && (
        <div
          className="no-print"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(33,40,31,0.55)",
            zIndex: 50,
            overflowY: "auto",
            padding: "24px 14px",
          }}
        >
          <div style={{ maxWidth: 460, margin: "0 auto", background: "#fff", borderRadius: 12, padding: 22, border: `1px solid ${COLORS.line}` }}>
            {invoiceImageUrl ? (
              <img
                src={invoiceImageUrl}
                alt="Invoice"
                style={{ width: "100%", height: "auto", display: "block", border: `1px solid ${COLORS.line}`, borderRadius: 8 }}
              />
            ) : (
            <div>
            <div style={{ display: "flex", justifyContent: "space-between", borderBottom: `2px solid ${COLORS.ink}`, paddingBottom: 12, marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 11, letterSpacing: "0.18em", color: COLORS.gold, fontWeight: 700 }}>{brandEyebrow}</div>
                <div style={{ fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 700 }}>Invoice</div>
              </div>
              <div style={{ textAlign: "right", fontSize: 12, color: COLORS.muted }}>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, color: COLORS.ink }}>{invoiceView.invoiceNo}</div>
                <div>{fmtDate(new Date(invoiceView.sale.date + "T00:00:00"))}</div>
              </div>
            </div>

            {[
              ["Billed To", invoiceView.sale.customerName || "Walk-in Customer"],
              [
                "Item",
                `${categoryLabel(categories, "income", invoiceView.sale.category)}${
                  invoiceView.sale.description ? " - " + invoiceView.sale.description : ""
                }`,
              ],
              ["Payment Type", invoiceView.sale.source === "Credit" ? "Credit" : "Cash"],
            ].map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: `1px solid ${COLORS.line}`, fontSize: 14 }}>
                <span style={{ color: COLORS.muted }}>{k}</span>
                <span style={{ textAlign: "right" }}>{v}</span>
              </div>
            ))}

            <div style={{ display: "flex", justifyContent: "space-between", padding: "14px 0 4px", fontWeight: 700, fontSize: 18 }}>
              <span>Total</span>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{naira(invoiceView.sale.amount)}</span>
            </div>
            <div
              style={{
                display: "inline-block",
                marginTop: 8,
                padding: "6px 12px",
                borderRadius: 20,
                fontSize: 12,
                fontWeight: 700,
                color: "#fff",
                background: invoiceStatus(invoiceView.sale).color,
              }}
            >
              {invoiceStatus(invoiceView.sale).label}
            </div>
            </div>
            )}

            {invoiceImageUrl && (
              <div style={{ ...styles.hintNote, marginTop: 8, textAlign: "center" }}>
                Tip: press and hold the invoice image to save or share it.
              </div>
            )}
            <div style={{ marginTop: 20 }}>
              <label style={styles.label}>
                Customer WhatsApp number (for the text version)
                <input
                  type="tel"
                  inputMode="tel"
                  placeholder="e.g. 08012345678"
                  value={invoicePhone}
                  onChange={(e) => setInvoicePhone(e.target.value)}
                  style={styles.input}
                />
              </label>
              <div style={{ ...styles.hintNote, marginBottom: 10 }}>For the image, you pick the contact inside the share menu.</div>
              <button
                type="button"
                onClick={shareInvoiceImage}
                style={{ ...styles.submitBtn, background: "#25D366", width: "100%", marginTop: 0 }}
              >
                Send Invoice as Image
              </button>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" onClick={saveInvoiceImage} style={{ ...styles.cancelBtn, flex: 1 }}>
                  Save Image
                </button>
                <button type="button" onClick={openInvoiceImage} style={{ ...styles.cancelBtn, flex: 1 }}>
                  Open Image
                </button>
                <button type="button" onClick={sendInvoiceWhatsApp} style={{ ...styles.cancelBtn, flex: 1 }}>
                  Send as Text
                </button>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" onClick={copyInvoiceText} style={{ ...styles.cancelBtn, flex: 1 }}>
                  Copy Text
                </button>
                <button type="button" onClick={() => setInvoiceView(null)} style={{ ...styles.cancelBtn, flex: 1 }}>
                  Close
                </button>
              </div>
              {invoiceNote && <div style={{ ...styles.hintNote, marginTop: 10 }}>{invoiceNote}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div style={{ flex: "1 1 150px", background: "#fff", border: `1px solid ${COLORS.line}`, borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 11, color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 19, fontWeight: 700, marginTop: 4, color: color || COLORS.ink }}>{value}</div>
    </div>
  );
}

function StRow({ label, value, bold, indent, subtotal, total, highlight }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: total ? "10px 0" : "6px 0",
        paddingLeft: indent ? 16 : 0,
        borderTop: total ? `2px solid ${COLORS.ink}` : subtotal ? `1px solid ${COLORS.line}` : "none",
        marginTop: total ? 4 : 0,
      }}
    >
      <span
        style={{
          fontFamily: "'Inter', sans-serif",
          fontSize: total ? 15 : 14,
          fontWeight: bold || total ? 700 : subtotal ? 600 : 400,
          color: indent ? COLORS.muted : COLORS.ink,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: total ? 16 : 14,
          fontWeight: bold || total ? 700 : 400,
          color: highlight || (value < 0 ? COLORS.rust : COLORS.ink),
        }}
      >
        {value < 0 ? "−" : ""}
        {naira(Math.abs(value))}
      </span>
    </div>
  );
}

const COLORS = {
  paper: "#F6F3EC",
  ink: "#21281F",
  green: "#2F5233",
  rust: "#A6491E",
  gold: "#C9A227",
  line: "#D8D2C2",
  muted: "#7A7566",
  rowAlt: "#EFEBE0",
  card: "#FFFFFF",
};

const styles = {
  app: {
    minHeight: "100vh",
    background: COLORS.paper,
    color: COLORS.ink,
    fontFamily: "'Inter', sans-serif",
    padding: "20px 16px 60px",
    maxWidth: 720,
    margin: "0 auto",
  },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
    borderBottom: `2px solid ${COLORS.ink}`,
    paddingBottom: 18,
    marginBottom: 18,
  },
  masthead: { textAlign: "center" },
  mastheadEyebrow: {
    fontSize: 11,
    letterSpacing: "0.18em",
    color: COLORS.gold,
    fontWeight: 700,
  },
  mastheadTitle: {
    fontFamily: "'Fraunces', serif",
    fontSize: 34,
    fontWeight: 700,
    margin: "2px 0 0",
  },
  mastheadSub: { fontSize: 12, color: COLORS.muted, letterSpacing: "0.05em" },
  stub: {
    background: COLORS.card,
    border: `1px dashed ${COLORS.line}`,
    borderRadius: 10,
    padding: "12px 16px",
  },
  stubRow: { display: "flex", justifyContent: "space-between", padding: "3px 0" },
  stubLabel: { fontSize: 13, color: COLORS.muted },
  stubValue: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 15 },
  stubDivider: { borderTop: `1px dashed ${COLORS.line}`, margin: "6px 0" },
  tabs: { display: "flex", gap: 8, marginBottom: 16 },
  tabBtn: {
    flex: 1,
    padding: "10px 0",
    border: `1px solid ${COLORS.line}`,
    background: "transparent",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    color: COLORS.muted,
    cursor: "pointer",
  },
  tabBtnActive: { background: COLORS.ink, color: "#fff", borderColor: COLORS.ink },
  errorBanner: {
    background: "#FBEAE3",
    color: COLORS.rust,
    padding: "8px 12px",
    borderRadius: 8,
    fontSize: 13,
    marginBottom: 12,
  },
  loading: { color: COLORS.muted, fontSize: 14, padding: "20px 0" },
  card: {
    background: COLORS.card,
    border: `1px solid ${COLORS.line}`,
    borderRadius: 12,
    padding: 18,
  },
  typeToggle: { display: "flex", gap: 8, marginBottom: 16 },
  toggleBtn: {
    flex: 1,
    padding: "10px 0",
    border: `1px solid ${COLORS.line}`,
    borderRadius: 8,
    background: "transparent",
    fontSize: 13,
    fontWeight: 700,
    color: COLORS.ink,
    cursor: "pointer",
  },
  form: { display: "flex", flexDirection: "column", gap: 12 },
  label: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: COLORS.muted, fontWeight: 600 },
  input: {
    padding: "10px 10px",
    borderRadius: 8,
    border: `1px solid ${COLORS.line}`,
    fontSize: 14,
    color: COLORS.ink,
    background: "#FCFBF8",
  },
  submitBtn: {
    marginTop: 6,
    padding: "12px 0",
    borderRadius: 8,
    border: "none",
    background: COLORS.ink,
    color: "#fff",
    fontWeight: 700,
    fontSize: 14,
    cursor: "pointer",
  },
  filterRow: { display: "flex", gap: 8, alignItems: "center", marginBottom: 16, flexWrap: "wrap" },
  filterInput: {
    padding: "8px 10px",
    borderRadius: 8,
    border: `1px solid ${COLORS.line}`,
    fontSize: 13,
    background: "#FCFBF8",
    color: COLORS.ink,
  },
  printBtn: {
    marginLeft: "auto",
    padding: "8px 14px",
    borderRadius: 8,
    border: `1px solid ${COLORS.ink}`,
    background: "transparent",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    color: COLORS.ink,
  },
  empty: { color: COLORS.muted, fontSize: 14, textAlign: "center", padding: "24px 0" },
  hintNote: {
    fontSize: 12,
    color: COLORS.muted,
    fontStyle: "italic",
    marginTop: 6,
  },
  table: { fontSize: 13 },
  theadRow: { borderBottom: `2px solid ${COLORS.ink}` },
  th: { textAlign: "left", padding: "8px 6px", fontSize: 11, letterSpacing: "0.05em", color: COLORS.muted },
  td: { padding: "8px 6px", borderBottom: `1px solid ${COLORS.line}` },
  deleteBtn: {
    border: "none",
    background: "transparent",
    color: COLORS.rust,
    cursor: "pointer",
    fontSize: 13,
  },
  creditRow: {
    border: `1px solid ${COLORS.line}`,
    borderRadius: 10,
    padding: "10px 12px",
    background: "#FCFBF8",
  },
  confirmBtn: {
    padding: "7px 14px",
    borderRadius: 8,
    border: "none",
    background: COLORS.green,
    color: "#fff",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  cancelBtn: {
    padding: "7px 14px",
    borderRadius: 8,
    border: `1px solid ${COLORS.line}`,
    background: "transparent",
    color: COLORS.muted,
    fontSize: 12,
    cursor: "pointer",
  },
  reportLabel: {
    fontFamily: "'Fraunces', serif",
    fontSize: 18,
    fontWeight: 600,
    marginBottom: 14,
    color: COLORS.ink,
  },
  statementBlock: { marginBottom: 22 },
  statementTitle: {
    fontSize: 12,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: COLORS.gold,
    fontWeight: 700,
    marginBottom: 8,
    borderBottom: `1px solid ${COLORS.line}`,
    paddingBottom: 6,
  },
  statementSubhead: {
    fontSize: 12,
    color: COLORS.muted,
    fontStyle: "italic",
    marginTop: 8,
    marginBottom: 2,
  },
};

function App() {
  const [client, setClient] = useState(null);
  const [status, setStatus] = useState(null);
  const [authMode, setAuthMode] = useState("login");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [passwordResetRequired, setPasswordResetRequired] = useState(false);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const [invitationReady, setInvitationReady] = useState(false);
  const [requests, setRequests] = useState([]);
  const [organizations, setOrganizations] = useState([]);
  const path = window.location.pathname.replace(/\/$/, "") || "/login";
  const adminRoute = path === "/super-admin/login";
  const signupRoute = path === "/signup";

  const loadAccount = async (supabase, token) => {
    const { data: identity } = await supabase.auth.getUser(token);
    setPasswordResetRequired(identity.user?.app_metadata?.force_password_reset === true);
    if (signupRoute) setInvitationReady(!!identity.user);
    const response = await fetch("/api/session", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not check account status.");
    if (result.kind === "company_user" && result.status === "active" && result.memberStatus === "active") {
      window.activeOrganizationId = result.organizationId;
      window.activeUserId = result.userId;
      window.storage = window.makeSupabaseStorage();
      setStatus(result);
      return result;
    }
    window.activeOrganizationId = null;
    window.activeUserId = null;
    window.storage = null;
    setStatus(result);
    return result;
  };

  useEffect(() => {
    (async () => {
      if (window.location.hash.includes("type=recovery") || new URLSearchParams(window.location.search).get("type") === "recovery") setPasswordRecovery(true);
      try {
        const configResponse = await fetch("/api/config", { cache: "no-store" });
        const config = await configResponse.json();
        if (!configResponse.ok) throw new Error(config.error || "Authentication is not configured.");
        const supabase = window.supabase.createClient(config.url, config.anonKey, { auth: { detectSessionInUrl: true, flowType: "pkce" } });
        supabase.auth.onAuthStateChange((event) => { if (event === "PASSWORD_RECOVERY") setPasswordRecovery(true); });
        window.sbClient = supabase;
        setClient(supabase);
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          const account = await loadAccount(supabase, data.session.access_token);
          if (account.kind === "platform_admin" && adminRoute) await loadAdminData(supabase, data.session.access_token);
        }
      } catch (e) { setError(e.message || "Could not connect to the service."); }
      finally { setBusy(false); }
    })();
  }, []);

  useEffect(() => {
    if (!client || !status?.organizationId) return;
    const refreshAccess = async () => {
      const { data } = await client.auth.getSession();
      if (!data.session) { setStatus(null); window.storage = null; return; }
      try { await loadAccount(client, data.session.access_token); }
      catch (e) { setError(e.message || "Could not refresh company access."); }
    };
    const timer = window.setInterval(refreshAccess, 30000);
    window.addEventListener("focus", refreshAccess);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refreshAccess); };
  }, [client, status?.organizationId]);

  const loadRequests = async (supabase, token) => {
    const response = await fetch("/api/admin/requests", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load signup requests.");
    setRequests(result.requests || []);
  };

  const loadAdminData = async (supabase, token) => {
    await loadRequests(supabase, token);
    const response = await fetch("/api/admin/organizations", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load companies.");
    setOrganizations(result.organizations || []);
  };

  const signOut = async () => {
    if (client) await client.auth.signOut();
    window.storage = null;
    window.activeOrganizationId = null;
    window.activeUserId = null;
    setStatus(null);
    setPasswordResetRequired(false);
    setInvitationReady(false);
    setRequests([]);
    setOrganizations([]);
    setNotice("");
  };

  const submitLogin = async (email, password) => {
    setError("");
    setBusy(true);
    try {
      const { data, error: loginError } = await client.auth.signInWithPassword({ email, password });
      if (loginError || !data.session) throw loginError || new Error("Login failed.");
      if (data.user?.app_metadata?.force_password_reset === true) setPasswordResetRequired(true);
      const account = await loadAccount(client, data.session.access_token);
      if (adminRoute) {
        if (account.kind !== "platform_admin") { await signOut(); throw new Error("This account is not authorized for the super-admin portal."); }
        await loadAdminData(client, data.session.access_token);
      } else if (account.kind === "platform_admin") {
        setNotice("Super-admin account verified. Use the separate super-admin portal.");
      }
    } catch (e) { setError(e.message || "Login failed."); }
    finally { setBusy(false); }
  };

  const acceptInvitation = async (password) => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const { data, error: updateError } = await client.auth.updateUser({ password });
      if (updateError || !data.user) throw updateError || new Error("Could not set your password.");
      const response = await fetch("/api/org/accept-invitation", { method: "POST", headers: { Authorization: `Bearer ${(await client.auth.getSession()).data.session.access_token}` } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not accept invitation.");
      if (result.pendingActivation) {
        await client.auth.signOut();
        window.activeOrganizationId = null; window.activeUserId = null; window.storage = null;
        setStatus(null); setInvitationReady(false);
        setNotice("Your invitation is recorded. Ledger access will be available after company activation.");
      } else window.location.assign("/login");
    } catch (e) { setError(e.message || "Could not accept invitation."); }
    finally { setBusy(false); }
  };

  const requestPasswordReset = async (email) => {
    setError(""); setNotice(""); setBusy(true);
    try {
      const { error: resetError } = await client.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/login` });
      if (resetError) throw resetError;
      setNotice("If the email is registered, a password reset link has been sent.");
    } catch (e) { setError(e.message || "Could not request a password reset."); }
    finally { setBusy(false); }
  };

  const changePassword = async (password) => {
    setBusy(true); setError("");
    try {
      const { error: updateError } = await client.auth.updateUser({ password });
      if (updateError) throw updateError;
      if (passwordResetRequired) {
        const { data } = await client.auth.getSession();
        const response = await fetch("/api/auth/complete-password-reset", { method: "POST", headers: { Authorization: `Bearer ${data.session.access_token}` } });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not complete the required password reset.");
        if (adminRoute) await loadAdminData(client, data.session.access_token);
      }
      setPasswordResetRequired(false); setPasswordRecovery(false); setNotice("Password updated. You can continue.");
    } catch (e) { setError(e.message || "Could not update password."); }
    finally { setBusy(false); }
  };

  const decideRequest = async (requestId, decision) => {
    const reason = decision === "reject" || decision === "suspend" ? window.prompt("Enter a reason for this decision:") : "";
    if ((decision === "reject" || decision === "suspend") && !reason?.trim()) return;
    const { data } = await client.auth.getSession();
    const response = await fetch("/api/admin/decision", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify({ requestId, decision, reason }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Decision could not be saved.");
    await loadAdminData(client, data.session.access_token);
  };

  const adminPost = async (url, body) => {
    const { data } = await client.auth.getSession();
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Admin action could not be completed.");
    await loadAdminData(client, data.session.access_token);
    setNotice("Saved successfully.");
  };

  const center = { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F6F3EC", fontFamily: "'Inter', sans-serif", color: "#21281F", padding: 24 };
  const card = { width: "100%", maxWidth: adminRoute ? 640 : 380, background: "#fff", border: "1px solid #D8D2C2", borderRadius: 12, padding: 28 };
  const inputStyle = { display: "block", width: "100%", marginTop: 4, padding: "10px", borderRadius: 8, border: "1px solid #D8D2C2", fontSize: 14, boxSizing: "border-box" };
  const buttonStyle = { marginTop: 4, padding: "11px 14px", borderRadius: 8, border: "none", background: "#21281F", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer" };

  if (busy && !client) return <div style={center}><div style={card}>Connecting to Smart Book…</div></div>;
  if (!client) return <div style={center}><div style={card}><div style={{ color: "#A6491E" }}>{error}</div></div></div>;

  if (passwordResetRequired || passwordRecovery) return <div style={center}><form style={card} onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); changePassword(String(f.get("newPassword"))); }}>
    <div style={{ fontSize: 11, letterSpacing: "0.18em", color: "#C9A227", fontWeight: 700 }}>SMART BOOK</div><h2 style={{ fontFamily: "'Fraunces', serif" }}>Set a new password</h2>
    <label style={{ display: "block", fontSize: 12, color: "#7A7566", fontWeight: 600 }}>New password<input name="newPassword" type="password" minLength={12} required style={inputStyle} /></label>
    {error && <div style={{ color: "#A6491E", marginTop: 10 }}>{error}</div>}<button disabled={busy} style={{ ...buttonStyle, width: "100%", marginTop: 14 }}>Update password</button>
  </form></div>;

  if (status?.kind === "platform_admin" && adminRoute) {
    return <div style={{ ...center, alignItems: "flex-start" }}><div style={card}>
      <div style={{ fontSize: 11, letterSpacing: "0.18em", color: "#C9A227", fontWeight: 700 }}>SMART BOOK · PLATFORM</div>
      <h2 style={{ fontFamily: "'Fraunces', serif", margin: "4px 0 18px" }}>Company approval requests</h2>
      <button onClick={signOut} style={{ ...buttonStyle, float: "right", marginTop: -48 }}>Log Out</button>
      {error && <div style={{ color: "#A6491E", marginBottom: 12 }}>{error}</div>}
      {status.role === "super_admin" && <form onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); adminPost("/api/admin/org/provision-owner", { companyName: f.get("companyName"), contactName: f.get("contactName"), email: f.get("ownerEmail"), phone: f.get("phone") }).catch((e) => setError(e.message)); event.currentTarget.reset(); }} style={{ border: "1px solid #D8D2C2", borderRadius: 8, padding: 14, marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 8px" }}>Invite company owner</h3>
        {[ ["Company name", "companyName", "text"], ["Owner name", "contactName", "text"], ["Owner email", "ownerEmail", "email"], ["Phone (optional)", "phone", "tel"] ].map(([label, name, type]) => <label key={name} style={{ display: "block", fontSize: 12, color: "#7A7566", fontWeight: 600, marginTop: 8 }}>{label}<input name={name} type={type} required={name !== "phone"} style={inputStyle} /></label>)}
        <button style={{ ...buttonStyle, marginTop: 12 }}>Invite owner and create pending company</button>
      </form>}
      {status?.role === "super_admin" && <form onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); adminPost("/api/admin/invite", { email: f.get("adminEmail"), role: f.get("adminRole") }).catch((e) => setError(e.message)); event.currentTarget.reset(); }} style={{ border: "1px solid #D8D2C2", borderRadius: 8, padding: 14, marginBottom: 16 }}>
        <h3 style={{ margin: "0 0 8px" }}>Invite platform admin</h3><label style={{ display: "block", fontSize: 12, color: "#7A7566", fontWeight: 600 }}>Email<input name="adminEmail" type="email" required style={inputStyle} /></label>
        <label style={{ display: "block", fontSize: 12, color: "#7A7566", fontWeight: 600, marginTop: 8 }}>Role<select name="adminRole" style={inputStyle}><option value="admin">Admin</option><option value="super_admin">Super admin</option></select></label><button style={{ ...buttonStyle, marginTop: 12 }}>Send admin invitation</button>
      </form>}
      <h3 style={{ marginBottom: 6 }}>Pending signup requests</h3>
      {!requests.length ? <div style={{ color: "#7A7566", padding: "14px 0" }}>No pending company requests.</div> : requests.map((item) => <div key={item.id} style={{ borderTop: "1px solid #D8D2C2", padding: "14px 0" }}>
        <strong>{item.company_name}</strong><div style={{ fontSize: 13, color: "#7A7566", marginTop: 5 }}>{item.contact_name} · {item.email}{item.phone ? ` · ${item.phone}` : ""}</div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button style={buttonStyle} onClick={() => decideRequest(item.id, "activate").catch((e) => setError(e.message))}>Activate company</button>
          <button style={{ ...buttonStyle, background: "#A6491E" }} onClick={() => decideRequest(item.id, "reject").catch((e) => setError(e.message))}>Reject</button>
        </div>
      </div>)}
      <h3 style={{ borderTop: "1px solid #D8D2C2", marginTop: 18, paddingTop: 16, marginBottom: 4 }}>Companies</h3>
      {organizations.map((org) => {
        const req = Array.isArray(org.organization_signup_requests) ? org.organization_signup_requests[0] : org.organization_signup_requests;
        return <div key={org.id} style={{ borderTop: "1px solid #D8D2C2", padding: "12px 0" }}>
          <strong>{org.name}</strong><span style={{ marginLeft: 8, color: "#7A7566", fontSize: 12 }}>{org.status}</span>
          <div style={{ fontSize: 12, color: "#7A7566", marginTop: 4 }}>{req?.contact_name || ""}{req?.email ? ` · ${req.email}` : ""}</div>
          {org.trial_ends_at && <div style={{ fontSize: 12, color: "#7A7566", marginTop: 4 }}>Trial: {org.trial_count} {org.trial_unit}{org.trial_count === 1 ? "" : "s"} · ends {new Date(org.trial_ends_at).toLocaleDateString("en-GB")}</div>}
          {status?.role === "super_admin" && <form onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); adminPost(`/api/admin/org/${org.id}/set-trial`, { unit: f.get("unit"), count: Number(f.get("count")) }).catch((e) => setError(e.message)); }} style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 9 }}>
            <input aria-label="Trial count" name="count" type="number" min="1" max="1000" defaultValue="1" style={{ ...inputStyle, width: 76, marginTop: 0 }} /><select name="unit" aria-label="Trial unit" style={{ ...inputStyle, width: 100, marginTop: 0 }}><option value="day">day</option><option value="week">week</option><option value="month">month</option><option value="year">year</option></select><button style={{ ...buttonStyle, marginTop: 0 }}>Set trial</button>
          </form>}
          {req?.id && <div style={{ display: "flex", gap: 8, marginTop: 9 }}>
            {org.status === "active" && <button style={{ ...buttonStyle, background: "#A6491E" }} onClick={() => decideRequest(req.id, "suspend").catch((e) => setError(e.message))}>Suspend</button>}
            {org.status === "suspended" && <button style={buttonStyle} onClick={() => decideRequest(req.id, "reactivate").catch((e) => setError(e.message))}>Reactivate</button>}
          </div>}
        </div>;
      })}
    </div></div>;
  }

  if (!signupRoute && ((status?.kind === "company_user" && !(status.status === "active" && status.memberStatus === "active")) || (status?.kind === "platform_admin" && !adminRoute))) {
    const label = status.status === "pending" ? "Your company is awaiting super-admin approval. Ledger access is disabled." : status.status === "rejected" ? `This company request was rejected${status.rejectionReason ? `: ${status.rejectionReason}` : ". Contact Smart Book support for details."}` : status.status === "suspended" ? "This company account is suspended. Ledger access is disabled." : status.status === "no_organization" ? "This account is not linked to a company yet." : status.kind === "platform_admin" ? "Use the separate super-admin portal to manage company requests." : status.memberStatus === "invited" ? "Accept the company invitation from your email to activate your access." : "Your account does not currently have active company access.";
    return <div style={center}><div style={card}><div style={{ fontSize: 11, letterSpacing: "0.18em", color: "#C9A227", fontWeight: 700 }}>SMART BOOK</div><h2 style={{ fontFamily: "'Fraunces', serif", margin: "4px 0 12px" }}>Account status</h2><div style={{ background: "#EFEBE0", padding: 14, borderRadius: 8, fontSize: 14, lineHeight: 1.5 }}>{label}</div><button onClick={signOut} style={{ ...buttonStyle, marginTop: 16 }}>Log Out</button></div></div>;
  }

  if (signupRoute) return <div style={center}><form style={card} onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); acceptInvitation(String(f.get("password"))); }}>
    <div style={{ textAlign: "center", marginBottom: 20 }}><div style={{ fontSize: 11, letterSpacing: "0.18em", color: "#C9A227", fontWeight: 700 }}>SMART BOOK</div><div style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 700 }}>Accept company invitation</div></div>
    {!invitationReady ? <div style={{ color: "#7A7566", fontSize: 14, lineHeight: 1.5 }}>Company access is invitation-only. Open the invitation link sent to your email to continue.</div> : <label style={{ display: "block", fontSize: 12, color: "#7A7566", fontWeight: 600 }}>Create password (12 characters minimum)<input name="password" type="password" minLength={12} required style={inputStyle} /></label>}
    {error && <div style={{ color: "#A6491E", marginTop: 10, fontSize: 13 }}>{error}</div>}{notice && <div style={{ color: "#2F5233", marginTop: 10, fontSize: 13 }}>{notice}</div>}
    {invitationReady && <button disabled={busy} style={{ ...buttonStyle, width: "100%", marginTop: 14 }}>{busy ? "Accepting…" : "Set password and accept"}</button>}<div style={{ fontSize: 12, marginTop: 14 }}><a href="/login">Already registered? Log in</a></div>
  </form></div>;

  if (status?.kind === "company_user" && status.status === "active" && status.memberStatus === "active") {
    return <div><div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 16px", background: "#21281F", color: "#fff", fontSize: 12 }}><span>{status.organizationName}</span><button onClick={signOut} style={{ background: "transparent", border: "1px solid #545C51", color: "#fff", borderRadius: 6, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>Log Out</button></div><MeatShareLedger key={status.organizationId} orgName={status.organizationName} role={status.role} /></div>;
  }

  return <div style={center}><form style={card} onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); if (resetMode) requestPasswordReset(String(f.get("email"))); else submitLogin(String(f.get("email")), String(f.get("password"))); }}>
    <div style={{ textAlign: "center", marginBottom: 20 }}><div style={{ fontSize: 11, letterSpacing: "0.18em", color: "#C9A227", fontWeight: 700 }}>SMART BOOK</div><div style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 700, marginTop: 2 }}>{adminRoute ? "Super Admin" : "The Ledger"}</div></div>
    <label style={{ display: "block", fontSize: 12, color: "#7A7566", fontWeight: 600 }}>Email<input name="email" type="email" required style={inputStyle} /></label>
    {!resetMode && <label style={{ display: "block", fontSize: 12, color: "#7A7566", fontWeight: 600, marginTop: 12 }}>Password<input name="password" type="password" required style={inputStyle} /></label>}
    {error && <div style={{ color: "#A6491E", fontSize: 12, marginTop: 10 }}>{error}</div>}{notice && <div style={{ color: "#2F5233", fontSize: 12, marginTop: 10 }}>{notice}</div>}
    <button disabled={busy} style={{ ...buttonStyle, width: "100%", marginTop: 14 }}>{busy ? "Checking…" : resetMode ? "Send reset link" : "Log In"}</button>
    <div style={{ fontSize: 12, marginTop: 12 }}><button type="button" onClick={() => { setResetMode(!resetMode); setError(""); setNotice(""); }} style={{ border: 0, background: "none", color: "#7A7566", padding: 0, cursor: "pointer", textDecoration: "underline" }}>{resetMode ? "Back to login" : "Forgot password?"}</button></div>
    {!adminRoute && <div style={{ fontSize: 12, marginTop: 14 }}><a href="/signup">Have an invitation? Accept it</a></div>}
    {!adminRoute && <div style={{ fontSize: 11, marginTop: 16 }}><a href="/super-admin/login">Platform admin</a></div>}
  </form></div>;
}

const root = createRoot(document.getElementById("root"));
root.render(<App />);
