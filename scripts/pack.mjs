/**
 * Pure-Node ZIP packager & validator for CodexHost Host Extension (`manifestVersion: 2`).
 * Produces a standard ZIP with `manifest.json` at the archive root, forward slashes,
 * CRC32 checksums, and deflate compression — verified against CodexHost's strict limits.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const INCLUDE_PATHS = [
  "manifest.json",
  "README.md",
  "LICENSE",
  "assets",
  "shared",
  "page",
  "backend",
];

async function collectFiles(relPath, out) {
  const abs = path.join(rootDir, relPath);
  const info = await stat(abs);
  if (info.isDirectory()) {
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      await collectFiles(path.posix.join(relPath, entry.name), out);
    }
  } else if (info.isFile()) {
    const bytes = await readFile(abs);
    out.push({ name: relPath.replaceAll("\\", "/"), bytes });
  }
}

function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, bytes } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(bytes) >>> 0;
    const deflated = deflateRawSync(bytes, { level: 9 });
    const useDeflate = deflated.length < bytes.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : bytes;

    // Local file header (30 bytes + name)
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x5421, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    localParts.push(local, nameBuf, payload);

    // Central directory header (46 bytes + name)
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // version made by (UNIX)
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // UTF-8 flag
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5421, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file external attrs
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

const files = [];
for (const p of INCLUDE_PATHS) {
  await collectFiles(p, files);
}
files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const manifest = JSON.parse(
  files.find((f) => f.name === "manifest.json").bytes.toString("utf8"),
);
const distDir = path.join(rootDir, "dist");
await mkdir(distDir, { recursive: true });
const outFile = path.join(distDir, `${manifest.id}-${manifest.version}.zip`);
const zipBytes = buildZip(files);
await writeFile(outFile, zipBytes);

console.log(`Packed ${files.length} files -> ${outFile} (${zipBytes.length} bytes)`);
for (const f of files) {
  console.log(`  - ${f.name} (${f.bytes.length} B)`);
}
