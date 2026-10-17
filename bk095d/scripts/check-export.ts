import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";

process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
const { createWorkbook } = await import("../api/export-org.js");

const data = createWorkbook([["transactions", [{ id: "row-1", amount: 45, payload: { note: "Rice & meat <paid>" } }]]]);
assert.equal(data.subarray(0, 4).toString("hex"), "504b0304", "xlsx output must be a ZIP package");
const files = new Map<string, string>();
let offset = 0;
while (data.readUInt32LE(offset) === 0x04034b50) {
  const method = data.readUInt16LE(offset + 8);
  const compressedSize = data.readUInt32LE(offset + 18);
  const nameLength = data.readUInt16LE(offset + 26);
  const extraLength = data.readUInt16LE(offset + 28);
  const name = data.subarray(offset + 30, offset + 30 + nameLength).toString();
  const start = offset + 30 + nameLength + extraLength;
  const payload = data.subarray(start, start + compressedSize);
  files.set(name, (method === 8 ? inflateRawSync(payload) : payload).toString());
  offset = start + compressedSize;
}
assert(files.has("[Content_Types].xml"), "workbook must include content types");
assert(files.get("xl/workbook.xml")?.includes('name="transactions"'), "workbook must include the organization data sheet");
assert(files.get("xl/worksheets/sheet1.xml")?.includes("Rice &amp; meat &lt;paid&gt;"), "sheet must escape untrusted cell text");
console.log("Excel export package checks passed.");
