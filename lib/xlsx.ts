export type SpreadsheetCell = string | number | boolean | null;

const textDecoder = new TextDecoder("utf-8");

function findEndOfCentralDirectory(view: DataView) {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("不是有效的 XLSX 文件：未找到 ZIP 目录。");
}

async function inflateRaw(data: Uint8Array) {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZipEntries(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const end = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries = new Map<string, Uint8Array>();

  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("XLSX ZIP 目录损坏。");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = textDecoder.decode(bytes.slice(offset + 46, offset + 46 + fileNameLength));

    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`XLSX 条目损坏：${name}`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataStart, dataStart + compressedSize);
    if (method === 0) entries.set(name, compressed);
    else if (method === 8) entries.set(name, await inflateRaw(compressed));
    else throw new Error(`不支持 XLSX 压缩方式 ${method}。`);
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function xmlDocument(bytes: Uint8Array | undefined, label: string) {
  if (!bytes) throw new Error(`XLSX 缺少 ${label}。`);
  const document = new DOMParser().parseFromString(textDecoder.decode(bytes), "application/xml");
  if (document.querySelector("parsererror")) throw new Error(`XLSX ${label} 无法解析。`);
  return document;
}

function columnIndex(reference: string) {
  const letters = reference.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? "A";
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

export async function readFirstXlsxSheet(file: File): Promise<SpreadsheetCell[][]> {
  if (!file.name.toLowerCase().endsWith(".xlsx")) throw new Error("只支持标准 .xlsx 文件。");
  if (file.size > 10 * 1024 * 1024) throw new Error("文件不能超过 10 MB。");
  const entries = await readZipEntries(await file.arrayBuffer());
  const sharedDocument = entries.has("xl/sharedStrings.xml")
    ? xmlDocument(entries.get("xl/sharedStrings.xml"), "sharedStrings.xml")
    : null;
  const sharedStrings = sharedDocument
    ? [...sharedDocument.querySelectorAll("si")].map((node) => [...node.querySelectorAll("t")].map((text) => text.textContent ?? "").join(""))
    : [];
  const sheet = xmlDocument(entries.get("xl/worksheets/sheet1.xml"), "第一个工作表");
  const rows: SpreadsheetCell[][] = [];
  for (const rowNode of sheet.querySelectorAll("sheetData > row")) {
    const row: SpreadsheetCell[] = [];
    for (const cell of rowNode.querySelectorAll(":scope > c")) {
      const index = columnIndex(cell.getAttribute("r") ?? "A1");
      const type = cell.getAttribute("t");
      const raw = cell.querySelector(":scope > v")?.textContent ?? "";
      let value: SpreadsheetCell = null;
      if (type === "s") value = sharedStrings[Number(raw)] ?? "";
      else if (type === "inlineStr") value = [...cell.querySelectorAll("is t")].map((node) => node.textContent ?? "").join("");
      else if (type === "b") value = raw === "1";
      else if (raw !== "") value = Number.isFinite(Number(raw)) ? Number(raw) : raw;
      while (row.length < index) row.push(null);
      row[index] = value;
    }
    rows.push(row);
  }
  if (!rows.length) throw new Error("Excel 第一个工作表没有数据。");
  return rows;
}
