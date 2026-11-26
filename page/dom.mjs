/**
 * Shared DOM builder and formatting helpers for MCP Hub page modules.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  }
  for (const child of children) {
    if (child) node.appendChild(child);
  }
  return node;
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  let deferredValue;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "className") node.className = v;
    else if (k === "text") node.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "value") {
      deferredValue = v;
    } else if (k === "checked" || k === "disabled") {
      node[k] = v;
    } else {
      node.setAttribute(k, String(v));
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === "string" || typeof child === "number") {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }
  if (deferredValue !== undefined) {
    node.value = deferredValue;
  }
  return node;
}

export function parseKvLines(text, sep) {
  const out = {};
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(sep);
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + sep.length).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function formatKvLines(obj, sep) {
  if (!obj || typeof obj !== "object") return "";
  return Object.entries(obj)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join("\n");
}

export function formatTransportPreview(transport) {
  if (!transport) return "";
  if (transport.type === "stdio") {
    return [transport.command, ...(transport.args ?? [])].join(" ");
  }
  return transport.url || "";
}

export function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
