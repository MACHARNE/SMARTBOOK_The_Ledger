import { deflateRawSync } from "node:zlib";
import { adminClient, bearerToken, requireSuperAdmin } from "./_lib/supabase.js";

const TABLES = ["business_profiles","categories","transactions","credit_sales","credit_payments","budgets","budget_items","audit_events","stock_items","stock_movements","commission_roles","workers","dispatches","vendor_remittances","commission_payments"] as const;

const xml = (value: unknown) => String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
const column = (index: number) => { let out = ""; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out; return out; };
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(data: Buffer) { let crc = 0xffffffff; for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function zip(files: Array<[string, string]>) {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [filename, content] of files) {
    const name = Buffer.from(filename); const raw = Buffer.from(content); const compressed = deflateRawSync(raw); const crc = crc32(raw);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50,0); head.writeUInt16LE(20,4); head.writeUInt16LE(8,6); head.writeUInt16LE(8,8); head.writeUInt16LE(33,12); head.writeUInt32LE(crc,14); head.writeUInt32LE(compressed.length,18); head.writeUInt32LE(raw.length,22); head.writeUInt16LE(name.length,26);
    local.push(head,name,compressed);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50,0); directory.writeUInt16LE(20,4); directory.writeUInt16LE(20,6); directory.writeUInt16LE(8,8); directory.writeUInt16LE(8,10); directory.writeUInt16LE(33,14); directory.writeUInt32LE(crc,16); directory.writeUInt32LE(compressed.length,20); directory.writeUInt32LE(raw.length,24); directory.writeUInt16LE(name.length,28); directory.writeUInt32LE(offset,42);
    central.push(directory,name); offset += head.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
export function createWorkbook(rowsBySheet: Array<[string, Record<string, unknown>[]]>) {
  const sheets = rowsBySheet.map(([name, rows], index) => {
    const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const records = [headers, ...rows.map((row) => headers.map((key) => row[key]))];
    const body = records.map((record, rowIndex) => `<row r="${rowIndex + 1}">${record.map((value, colIndex) => {
      const ref = `${column(colIndex)}${rowIndex + 1}`;
      const raw = value && typeof value === "object" ? JSON.stringify(value) : value;
      return typeof raw === "number" && Number.isFinite(raw) ? `<c r="${ref}" t="n"><v>${raw}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(raw)}</t></is></c>`;
    }).join("")}</row>`).join("");
    return { name, id: index + 1, body };
  });
  const files: Array<[string,string]> = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s) => `<Override PartName="/xl/worksheets/sheet${s.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s) => `<sheet name="${xml(s.name)}" sheetId="${s.id}" r:id="rId${s.id}"/>`).join("")}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s) => `<Relationship Id="rId${s.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.id}.xml"/>`).join("")}</Relationships>`],
    ...sheets.map((s) => [`xl/worksheets/sheet${s.id}.xml`, `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${s.body}</sheetData></worksheet>`] as [string,string]),
  ];
  return zip(files);
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });
  const token = bearerToken(request);
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let actorId: string;
  try { actorId = await requireSuperAdmin(token); } catch { return Response.json({ error: "Forbidden" }, { status: 403 }); }
  const match = new URL(request.url).pathname.match(/\/api\/export\/org\/([^/.]+)\.xlsx$/);
  if (!match) return Response.json({ error: "Organization ID is required." }, { status: 400 });
  const orgId = match[1];
  const { data: org, error: orgError } = await adminClient.from("organizations").select("name").eq("id", orgId).maybeSingle();
  if (orgError || !org) return Response.json({ error: "Organization not found." }, { status: 404 });
  const exportTables: Array<[string, Record<string, unknown>[]]> = [];
  for (const table of TABLES) {
    const rows: Record<string, unknown>[] = [];
    for (let start = 0; ; start += 1000) {
      const { data, error } = await adminClient.from(table).select("*").eq("organization_id", orgId).range(start, start + 999);
      if (error) return Response.json({ error: `Could not export ${table}.` }, { status: 500 });
      rows.push(...(data || []) as Record<string, unknown>[]);
      if ((data?.length || 0) < 1000) break;
    }
    exportTables.push([table, rows]);
  }
  const audit = await adminClient.from("audit_events").insert({ actor_user_id: actorId, action: "organization_exported", entity_type: "organization", entity_id: orgId, details: { organization_name: org.name } });
  if (audit.error) return Response.json({ error: "Export was prepared but could not be audited." }, { status: 500 });
  const bytes = createWorkbook(exportTables);
  const filename = `${String(org.name).replace(/[^a-z0-9-_]+/gi, "-").slice(0, 60) || "organization"}-export.xlsx`;
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" } });
}
