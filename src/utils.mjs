export function splitCommandLine(input) {
  const out = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let tokenStarted = false;

  for (const ch of String(input || "")) {
    if (escaped) {
      current += ch;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else {
        current += ch;
        tokenStarted = true;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (tokenStarted) {
        out.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += ch;
    tokenStarted = true;
  }
  if (escaped) current += "\\";
  if (tokenStarted) out.push(current);
  return out;
}

export function parseFlags(args) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [rawKey, rawValue] = arg.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (rawValue !== undefined) {
      appendFlagValue(flags, key, rawValue);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      appendFlagValue(flags, key, next);
      i += 1;
    } else {
      appendFlagValue(flags, key, true);
    }
  }
  return { flags, positionals };
}

export function flagEnabled(value) {
  if (Array.isArray(value)) return flagEnabled(value.at(-1));
  if (value === true) return true;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return ["true", "1", "yes", "y", "on"].includes(normalized);
  }
  return false;
}

function appendFlagValue(flags, key, value) {
  if (Object.prototype.hasOwnProperty.call(flags, key)) {
    flags[key] = Array.isArray(flags[key]) ? [...flags[key], value] : [flags[key], value];
  } else {
    flags[key] = value;
  }
}
