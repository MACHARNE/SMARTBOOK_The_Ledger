const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { parse } = require("@babel/parser");
const source = fs.readFileSync(path.resolve(__dirname, "../../fb091d/Ledger.jsx"), "utf8");
const tree = parse(source, { sourceType: "module", plugins: ["jsx"] });
const ledger = tree.program.body.find(node => node.type === "ExportDefaultDeclaration").declaration;
const named = (nodes, name) => nodes.find(node => node.type === "VariableDeclaration" && node.declarations.some(declaration => declaration.id.name === name));
const escape = named(tree.program.body, "escapeHtml");
let html;
const unsafe = '<img src=x onerror="alert(1)">';
const context = {
  brandEyebrow: unsafe, brandTitle: unsafe, brandSlug: "fixture", todayStr: () => "2026-10-18", naira: String,
  categories: {}, categoryLabel: () => unsafe, fmtDate: () => "18 October 2026",
  investorTrend: { weeks: [{label:"week",sales:1,expenses:0,profit:1}], months: [{label:"month",sales:1,expenses:0,profit:1}] },
  window: { open: () => ({ document: { open() {}, write(value) { html = value; }, close() {} } }) },
  URL: { createObjectURL() { return "blob:fixture"; }, revokeObjectURL() {} },
  Blob: function(parts) { html = parts.join(""); },
  document: { createElement: () => ({ click() {} }), body: { appendChild() {}, removeChild() {} } },
  setSaveError: message => { throw Error(message); },
};
vm.createContext(context);
vm.runInContext(source.slice(escape.start, escape.end), context);
for (const name of ["generateInvestorSnapshot", "downloadInvoiceFile"]) {
  const node = named(ledger.body.body, name);
  vm.runInContext(source.slice(node.start, node.end), context);
}
vm.runInContext("generateInvestorSnapshot()", context);
assert(!html.includes(unsafe)); assert(html.includes("&lt;img"));
context.sale = { customerName: unsafe, description: unsafe, method: unsafe, amount: 42, date: "2026-10-18", source: "Cash" };
vm.runInContext("downloadInvoiceFile(sale, 'fixture-invoice')", context);
assert(!html.includes(unsafe)); assert(html.includes("&lt;img"));
context.useMemo = calculate => calculate();
context.transactions = [{ id: "cash-fixture", date: "2026-10-18", type: "income", category: "sales", description: "Purchased goods", customerName: "Named cash customer", amount: 42, method: "Cash" }];
context.creditSales = [];
context.ledgerRangeStrs = { start: "2026-10-01", end: "2026-10-31" };
context.isCreditSettlement = () => false;
const salesRows = named(ledger.body.body, "salesLedgerRows");
vm.runInContext(source.slice(salesRows.start, salesRows.end), context);
assert.equal(vm.runInContext("salesLedgerRows[0].raw.customerName", context), "Named cash customer");
vm.runInContext("downloadInvoiceFile(salesLedgerRows[0].raw, 'cash-fixture')", context);
assert(html.includes("Named cash customer"));
console.log("Passed: document escaping and named cash customers on regenerated invoices.");
