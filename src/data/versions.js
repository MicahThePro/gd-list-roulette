/**
 * Which versions of the site can be played, and where each one lives.
 *
 * A frozen build of an old version is a static copy of that version's own dist/,
 * published under versions/<tag>/. It is a complete, working site at that URL: the
 * app is built with a relative base, so an old build works from whatever directory
 * it is served out of and keeps working wherever it is copied to.
 *
 * THE LIST BELOW IS THE ONE THING TO EDIT WHEN YOU TAG A NEW VERSION.
 *
 * An entry here is a claim that a build exists at that path. It is written by hand
 * rather than read from disk, because the browser cannot see the published
 * directory listing -- and a link to a version that was never built is worse than
 * no link at all: it looks like the feature is broken rather than absent. So the
 * claim is made deliberately, by whoever ran the build.
 *
 * To add a version:
 *   1. git tag v1.9 <the commit that shipped it> && git push origin v1.9
 *   2. npm run versions:build
 *   3. add 'v1.9' to PLAYABLE_VERSIONS below
 *   4. npm run deploy
 *
 * Step 3 is separate on purpose. Building a version and promising it is playable are
 * different claims, and the second one should be made once the first has actually
 * succeeded rather than in the same breath.
 */

/** Versions with a frozen build, newest first. */
export const PLAYABLE_VERSIONS = [
  'v2.6',
  'v2.5',
  'v2.4',
  'v2.3',
  'v2.2',
  'v2.1',
  'v2.0',
  'v1.9',
  'v1.8',
  'v1.7',
  'v1.6',
  'v1.5',
  'v1.4',
  'v1.3',
  'v1.2',
  'v1.1',
]

/** True when a version has a build to link to. */
export const isPlayable = (version) => PLAYABLE_VERSIONS.includes(version)

/**
 * The URL of a frozen version.
 *
 * Relative, resolved against the current page rather than built from a hardcoded
 * domain: the site is served from a repository subpath, and a root-absolute path
 * would 404 on GitHub Pages while working perfectly on a local machine.
 *
 * The trailing slash is load-bearing. Without it the host serves the directory
 * listing or redirects, and a relative asset path inside the build then resolves
 * one level too high.
 */
export const versionUrl = (version) => `./versions/${version}/`

/** Playable versions, for the changelog dialog to check against. */
export const playableVersions = PLAYABLE_VERSIONS
