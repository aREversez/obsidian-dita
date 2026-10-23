// The rules a release has to meet, as plain functions so they are unit-tested
// (scripts/release.test.mjs) and shared by the two command-line scripts.
//
// What they guard: Obsidian and BRAT install from a GitHub release whose tag is
// exactly the manifest version, and the community plugin directory reads
// manifest.json and versions.json from the repository root. Any of these
// drifting apart makes an install fail late, on someone else's machine.

export const SEMVER = /^\d+\.\d+\.\d+$/;

const REQUIRED_STRINGS = ['id', 'name', 'version', 'minAppVersion', 'description', 'author'];

/**
 * Everything wrong with a release, as readable sentences; empty when it is fit
 * to publish.
 *
 * @param {{
 *   manifest: Record<string, unknown>,
 *   versions: Record<string, unknown>,
 *   pluginVersion: string,
 *   tag?: string,
 * }} input  `tag` is the git tag being released, when there is one.
 * @returns {string[]}
 */
export function checkRelease({ manifest, versions, pluginVersion, tag }) {
  const problems = [];
  for (const key of REQUIRED_STRINGS) {
    if (typeof manifest[key] !== 'string' || manifest[key].trim() === '') {
      problems.push(`manifest.json: "${key}" must be a non-empty string.`);
    }
  }
  if (typeof manifest.isDesktopOnly !== 'boolean') {
    problems.push('manifest.json: "isDesktopOnly" must be true or false.');
  }
  const { id, version, minAppVersion, description } = manifest;
  if (typeof id === 'string' && id !== '') {
    if (!/^[a-z0-9-]+$/.test(id)) problems.push(`manifest.json: id "${id}" may only use lowercase letters, digits and hyphens.`);
    if (id.includes('obsidian')) problems.push('manifest.json: the id must not contain "obsidian".');
    if (id.endsWith('plugin')) problems.push('manifest.json: the id must not end with "plugin".');
  }
  if (typeof version === 'string' && !SEMVER.test(version)) {
    problems.push(`manifest.json: version "${version}" must be x.y.z, with no "v" and no suffix.`);
  }
  if (typeof minAppVersion === 'string' && !SEMVER.test(minAppVersion)) {
    problems.push(`manifest.json: minAppVersion "${minAppVersion}" must be x.y.z.`);
  }
  if (typeof description === 'string' && description !== '') {
    if (description.length > 250) problems.push(`manifest.json: the description is ${description.length} characters; the limit is 250.`);
    if (!/[.!?)]$/.test(description)) problems.push('manifest.json: the description should end with a full stop.');
  }

  if (typeof versions !== 'object' || versions === null || Array.isArray(versions)) {
    problems.push('versions.json must be an object of version: minAppVersion.');
  } else {
    for (const [v, min] of Object.entries(versions)) {
      if (!SEMVER.test(v) || typeof min !== 'string' || !SEMVER.test(min)) {
        problems.push(`versions.json: "${v}": ${JSON.stringify(min)} must be x.y.z: x.y.z.`);
      }
    }
    if (typeof version === 'string' && versions[version] !== minAppVersion) {
      problems.push(`versions.json: needs "${version}": "${minAppVersion}" to match manifest.json.`);
    }
  }

  if (pluginVersion !== version) {
    problems.push(`packages/obsidian-plugin/package.json is at ${pluginVersion}, manifest.json at ${version}.`);
  }
  if (tag !== undefined && tag !== version) {
    problems.push(`The tag "${tag}" must equal the manifest version "${version}" exactly (no leading "v").`);
  }
  return problems;
}

/**
 * The manifest and versions map for a new version: manifest.json takes the
 * version, versions.json gains it with the current minAppVersion. Nothing else
 * changes, and nothing is mutated.
 */
export function bumpVersions({ manifest, versions }, version) {
  if (!SEMVER.test(version)) throw new Error(`"${version}" is not x.y.z.`);
  return {
    manifest: { ...manifest, version },
    versions: { ...versions, [version]: manifest.minAppVersion },
  };
}
