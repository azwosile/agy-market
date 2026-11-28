// Zero-dependency SemVer parser & comparator (`src/shared/semver.mjs`).

export function parseSemver(raw) {
  const clean = String(raw || '').trim().replace(/^v/i, '');
  // Plugin manifests may use a fourth numeric revision (e.g. 2026.10.25.10).
  const m = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(clean);
  if (!m) return null;
  const revision = Number(m[4] || 0);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    revision,
    prerelease: m[5] ? m[5].split('.') : [],
    version: m.slice(1, 5).filter(part => part !== undefined).map(Number).join('.') + (m[5] ? '-' + m[5] : ''),
  };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return String(a || '').localeCompare(String(b || ''));
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.revision !== pb.revision) return pa.revision - pb.revision;
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx - ny;
    } else if (nx !== null) {
      return -1;
    } else if (ny !== null) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function isNewerVersion(candidateVersion, installedVersion) {
  if (!installedVersion) return true;
  return compareSemver(candidateVersion, installedVersion) > 0;
}

export function stripLeadingV(raw) {
  return String(raw ?? '').trim().replace(/^v+/i, '');
}
