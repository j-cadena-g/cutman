const manifestKeyPattern = /^\s*#?\s*([A-Z0-9_]+)=/;

export function parseManifestKeys(source) {
  const keys = [];
  const seen = new Set();

  for (const line of source.split(/\r?\n/)) {
    const match = line.match(manifestKeyPattern);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    keys.push(match[1]);
  }

  return keys;
}
