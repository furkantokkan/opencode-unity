// The protected-path tables of spec 8.5.2. Like `vcs-tables.js`, this is data with no imports, so the
// CLI (permission render, workspace scanner) and the plugin (shell guard) all read one list and run it
// in Node and Bun alike. A boundary that blocks a subset states the subset; none of them restates a
// glob.
//
// It lives under `plugin/` because only `plugin/` is copied into the rendered profile: the CLI may
// import the plugin, and the plugin may never import the CLI. That direction also keeps the workspace
// scanner out of a cycle with the renderer, which is where these lists would otherwise have met.

/**
 * Unity asset and project files the agent may never edit (`PROTECTED_EDIT`). Order is the spec's: file
 * extensions first, then directories. The permission rules use it as a glob map and the shell guard
 * uses it as a list, and the two boundaries must block the same files.
 * @type {readonly string[]}
 */
export const PROTECTED_EDIT_GLOBS = Object.freeze([
  '*.unity', '*.prefab', '*.asset', '*.meta', '*.mat', '*.controller', '*.overrideController',
  '*.anim', '*.mask', '*.mixer', '*.playable', '*.signal', '*.spriteatlas', '*.spriteatlasv2',
  '*.terrainlayer', '*.lighting', '*.renderTexture', '*.physicMaterial', '*.physicsMaterial2D',
  '*.shadergraph', '*.shadersubgraph', '*.vfx', '*.inputactions', '*.asmdef', '*.asmref',
  '*.csproj', '*.sln', '*.slnx', '*ProjectSettings/*', '*Packages/manifest.json',
  '*Packages/packages-lock.json', '*Library/*', '*Temp/*', '*Logs/*', '*UserSettings/*', '*obj/*',
  '*.opencode-unity/*',
]);

/**
 * Files the agent may never read (`PROTECTED_READ`). Secrets first, then the two Unity formats that are
 * large and useless to a coding model. The workspace scanner denies the same set, because anything it
 * opens can reach facts.md, project.json, a doctor report pasted into an issue, or the session log.
 * @type {readonly string[]}
 */
export const PROTECTED_READ_GLOBS = Object.freeze([
  '*.unity', '*.prefab', '*Library/*', '*.env', '*.env.*',
  '*.pem', '*.key', '*.p8', '*.p12', '*.pfx',
  '*.keystore', '*.jks', '*.mobileprovision', '*.ppk',
  '*id_rsa*', '*id_ed25519*', '*credentials*',
  '*service-account*.json', '*service_account*.json',
  '*google-services*.json', '*GoogleService-Info*.plist',
  '*.npmrc', '*.netrc', '*.git-credentials',
]);

/** The one read that stays allowed, and must be rendered after `*.env.*` to win (spec 8.5.2). */
export const PROTECTED_READ_ALLOW_GLOB = '*.env.example';
