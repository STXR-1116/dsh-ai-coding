# How `dsh` 0.1.5-rc.2 mounts a third-party plugin package

Read-only investigation. No source code was modified, and no install/mount command was run.

Evidence base (all installed artifacts, version `0.1.5-rc.2` unless stated):

| Short name | Path |
| --- | --- |
| `dsh` CLI | `C:\Users\13588\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\` |
| `app-boot` | `…\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js` |
| `client-modules` | `…\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-modules\lib\index.js`, `lib\client.js` |
| `typert-loader` | `…\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-typert-loader\lib\index.js` |
| `invariants` | `…\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-invariants\lib\index.js` |
| profile `web` | `C:\Users\13588\.dsh\profiles\web\` |
| old published packages | `C:\Users\13588\.dsh\profiles\node_modules\@deepseek-ai\dsh-ai-coding-platform\package.json`, `…\dsh-client-ui-ai-coding-platform\package.json` (both `0.1.1-rc.2`) |
| monorepo reference | `C:\Users\13588\Downloads\deepseek-harness-master1\deepseek-harness-master\` |

Note on the brief: the installed 0.1.5-rc.2 tree contains **no `dsh-boot` package**. The boot glue is
`@deepseek-ai/dsh-app-boot`; the profile launcher is `@deepseek-ai/dsh/lib/profile-boot-Dk-7KqJc.js`.
There is no `dsh.plugin.json` in the tree and no reference to that filename anywhere in the 0.1.5-rc.2
`@deepseek-ai/*` sources I searched. See Q1.7.

---

## Q1 — The exact schema of the mount/patch file the 0.1.5 loader accepts

### Q1.1 Which files become profile layers: `dsh.bundle.patch` in an installed dependency's `package.json`

A profile is **only** a list of bundle package names plus one user patch file. The profile manifest is
`<profile>/package.json`; the layer list is `dsh.profile.bundles`:

`C:\Users\13588\.dsh\profiles\web\package.json:1-14`
```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app"
      ],
      "patchReload": "live"
    }
  }
}
```

Each named bundle is resolved to a directory and its patch path is read from the **installed dependency's own
`package.json`**, key `dsh.bundle.patch`:

`app-boot/lib/index.js:849-860`
```js
	const layers = bundles.map((packageName) => {
		const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir);
		const declared = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).dsh?.bundle?.patch;
		if (declared === void 0) throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`);
		const patchPath = join(packageDir, declared);
		return {
			packageName,
			packageDir,
			patchPath,
			patches: loadOverlayPatches(binName, patchPath)
		};
	});
```

Confirmed against the first-party bundles (`dsh-base/package.json` and `dsh-web-app/package.json`):
```json
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
```
and both list `"cordis.patch.yml"` in `files` and map `"./cordis.patch.yml": "./cordis.patch.yml"` in `exports`.

**A `dsh.plugin.json`, and a bare `cordis.patch.yml` sitting loose in a package root without the
`dsh.bundle.patch` declaration, are both invisible to the loader.** The path in `dsh.bundle.patch` is free-form
relative to the package root; the filename `cordis.patch.yml` is only a convention.

### Q1.2 Who appends the package to `dsh.profile.bundles`: `dsh plugin --profile <p> add <spec>`

`dsh plugin` is a thin pnpm forwarder that then reconciles the layer list against the installed state:

`dsh/lib/plugin-Ddi42qoW.js:7-16` (module doc)
```
 * `dsh plugin --profile <name> <args...>` — profile plugin management as a
 * thin pnpm forwarder: initialize the profile on first use, run
 * `pnpm <args...>` in the profile directory, then reconcile the
 * `dsh.profile.bundles` layer list against the installed state (a dependency
 * resolving to a package that declares `dsh.bundle` joins the layer stack; a
 * removed or bundle-less dependency leaves it). Reconciling by installed
 * state, not by dependency diff, means `update` activates a package that
 * gained its `dsh.bundle` declaration in a newer version.
```

`dsh/lib/plugin-Ddi42qoW.js:25-33`
```js
function exportsPatch(packageName, profileDir) {
	let dir;
	try {
		dir = resolveBundleDir(NAME, packageName, INSTALL_ANCHOR, profileDir);
	} catch {
		return false;
	}
	return readProfileManifest(NAME, dir).dsh?.bundle?.patch !== void 0;
}
```

`dsh/lib/plugin-Ddi42qoW.js:52-59`
```js
	for (const packageName of dependencies) {
		const isBundle = exportsPatch(packageName, profileDir);
		if (isBundle && !plugins.includes(packageName)) {
			plugins.push(packageName);
			changed = true;
		} else if (!isBundle && !beforeDeps.has(packageName)) process.stderr.write(`${NAME}: warning: ${packageName} declares no dsh.bundle — installed as a plain dependency, not a profile layer (a later update that gains one activates it automatically)
`);
	}
```

So: **without `dsh.bundle.patch`, `dsh plugin add` prints a warning and mounts nothing.** This is the single
missing piece in our current `package.json`.

Resolution does **not** require an `exports["./package.json"]` entry:

`app-boot/lib/index.js:807-819`
```js
function packageDirFromAnchor(anchor, packageName, exclude = () => false) {
	/* v8 ignore next */
	for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
		const candidate = join(searchPath, packageName);
		if (existsSync(join(candidate, "package.json")) && !exclude(candidate, packageName)) return candidate;
	}
}
…
 * `@deepseek-ai/dsh-base` (and every other in-box bundle) always comes from
 * the same installation as the running dsh, never from a profile-local copy.
 * Resolution does not require the package to export `./package.json`.
```

Recommendation still: ship `"./package.json": "./package.json"` — every first-party package does, and it is
required by the CommonJS `require.resolve('<pkg>/package.json')` path in `client-modules` (Q2) and by
`typert-loader` (Q4). Our current `exports` block omits it.

### Q1.3 The patch file must be a top-level YAML **ARRAY** — an object is rejected

Two independent readers enforce it. The runtime include:

`app-boot/lib/index.js:180-194`
```js
		try {
			if (this.type === "application/yaml") data = yaml.load(content, { schema });
			else if (this.type === "application/json") data = JSON.parse(content);
			else {
				const module = await import(
					/* @vite-ignore */
					this.filename
);
				data = module.default || module;
			}
		} catch (error) {
			throw new ConfigFileError("parse", this.filename, error);
		}
		if (!Array.isArray(data)) throw new ConfigFileError("validate", this.filename, /* @__PURE__ */ new TypeError("config file must be a top-level array"));
```

And the overlay/bundle parser:

`app-boot/lib/index.js:1192-1204`
```js
function parsePatchList(binName, file, content, label) {
	let parsed;
	try {
		parsed = yaml.load(content, { schema: userPatchesSchema });
	} catch (error) {
		throw new Error(`${binName}: failed to parse ${label} ${file}: ${String(error)}`);
	}
	if (!Array.isArray(parsed)) throw new Error(`${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries`);
	parsed.forEach((entry, index) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${binName}: ${label} entry ${index + 1} in ${file} must be a mapping (a loader patch entry)`);
	});
	return anchorInsertedPluginNames(parsed, file);
}
```

**Verdict on the current `cordis.patch.yml`:** its `plugins:` / `overrides:` object shape is a hard
parse/validate failure. `loadOverlayPatches` throws, `loadProfileDirectory` propagates, and boot dies before
any plugin loads. It is not "ignored" — it is fatal.

### Q1.4 There is no zod/schemastery schema for a patch entry — validation is JSON_SCHEMA + structural

`app-boot/lib/index.js:17-31`
```js
const JsExpr = new yaml.Type("tag:yaml.org,2002:js", {
	kind: "scalar",
	resolve: (data) => typeof data === "string",
	construct: (data) => ({ __jsExpr: data }),
	predicate: isJsExpr,
	represent: (data) => data["__jsExpr"]
});
…
const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr);
const schema = entryListSchema;
```

`app-boot/lib/index.js:1100-1101`
```js
const bootstrapIncludes = /* @__PURE__ */ new WeakMap();
const userPatchesSchema = entryListSchema;
```

So the only "schema" is js-yaml's `JSON_SCHEMA` extended with the `!!js` scalar tag. Field-level semantics
live entirely in `applyEntryPatches`:

`app-boot/lib/index.js:59-108`
```js
function applyEntryPatches(data, patches, warn) {
	data = structuredClone(data);
	if (!patches?.length) return data;
	const entryMap = /* @__PURE__ */ new Map();
	const buildMap = (entries) => {
		for (const entry of entries) {
			if (entry.id) entryMap.set(entry.id, entry);
			if (entry.group && Array.isArray(entry.config)) buildMap(entry.config);
		}
	};
	buildMap(data);
	for (const patch of patches) {
		const { id, insert, name, ...overrides } = patch;
		if (insert) {
			if (id) {
				const target = entryMap.get(id);
				if (!target) {
					warn("patch insert: entry %C not found", id);
					continue;
				}
				if (!target.group) {
					warn("patch insert: entry %C is not a group", id);
					continue;
				}
				if (!Array.isArray(target.config)) target.config = [];
				target.config.push(...insert);
			} else data.push(...insert);
			buildMap(insert);
			continue;
		}
		if (!id) {
			warn("patch: id is required for non-insert patches");
			continue;
		}
		const target = entryMap.get(id);
		if (!target) {
			warn("patch: entry %C not found", id);
			continue;
		}
		if (name && name !== target.name) {
			warn("patch: name mismatch for %C (expected %C, got %C), skipping", id, target.name, name);
			continue;
		}
		for (const [key, value] of Object.entries(overrides)) {
			if (key === "id") continue;
			target[key] = value;
		}
	}
	return data;
}
```

Field semantics, precisely:

| Field | Meaning |
| --- | --- |
| `insert` | Array of **new** entry objects. With no `id`, they are appended to the top-level list. With `id`, they are pushed into that target **group**'s `config` array; a missing or non-group target warns and is skipped. |
| `id` | Target row id. **Required** for a non-`insert` patch; a patch with no `id` and no `insert` warns and is skipped. |
| `name` | Optional assertion. If present and `!== target.name`, the patch warns and is skipped. It does **not** rename anything. |
| `config` | Whole-value **replacement**, not a merge. This is why the first-party patches restate complete configs. |
| `disabled` | Ordinary override key. The field is `disabled` (boolean), **not** `disable`. |
| `group`, `inject`, … | Any other key is copied verbatim onto the target row. |

**Consequence that matters for us:** a new row must be introduced through `insert`. Writing our rows as bare
top-level array entries would make them *overrides* of ids that do not exist, producing only
`patch: entry %C not found` warnings and mounting nothing.

### Q1.5 The full layer stack, in application order

`dsh/lib/profile-boot-Dk-7KqJc.js:212-220`
```js
function allPatches(composed) {
	return [
		...composed.bundlePatches,
		...composed.profile.patches,
		...composed.homePatches,
		...composed.overlays
	];
}
```

`dsh/lib/profile-boot-Dk-7KqJc.js:232-247`
```js
async function composeProfile(name, patchFiles, fromDefaultProfile) {
	const profile = prepareProfile(name, true, fromDefaultProfile);
	await healProfilesModuleFallback({
		installAnchor: INSTALL_ANCHOR,
		profile
	});
	const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? [];
	const overlays = patchFiles.flatMap((file) => loadOverlayPatches(NAME, resolve(file)));
	const bundlePatches = profile.layers.flatMap((layer) => layer.patches);
	const rows = /* @__PURE__ */ new Map();
	for (const row of composeEntries([
		bundlePatches,
		profile.patches,
		homePatches,
		overlays
	])) if (typeof row.id === "string") rows.set(row.id, row);
```

So the order is: **bundle layers in `dsh.profile.bundles` order → the profile's `cordis.patch.yml` →
`$DSH_HOME/cordis.patch.yml` → `--patch` overlays → the telemetry switch.** Later wins.

The tree is patched over an empty root, which is rewritten on every boot:

`dsh/lib/profile-boot-Dk-7KqJc.js:123-130`
```js
/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
…
const PROFILE_ROOT_FILENAME = "cordis.yml";
```

A third-party package appended by `dsh plugin add` therefore lands **after** `@deepseek-ai/dsh-web-app`, and its
rows are composed last among bundle layers.

### Q1.6 Exact minimal content and exact `package.json` keys

File `cordis.patch.yml` (package root — top-level array):

```yaml
# The dsh-ai-coding bundle patch: the merged single-package mount rows, applied
# after every earlier layer (dsh-base, then dsh-web-app) when this package is
# listed in the profile's `dsh.profile.bundles`.
#
# A patch replaces the targeted row's whole `config`, so any later layer that
# wants different values restates every key it owns. Row order carries no load
# semantics (activation is service-availability driven).

- insert:
    # Host gateway (bare package name ⇒ this row IS the browser roster entry:
    # it is the only row that can carry `dsh.client`, see Q2/Q3).
    - id: ai-coding-platform
      name: 'dsh-ai-coding'
      config:
        apiBaseUrl: !!js process.env.DSH_AI_CODING_PLATFORM_API_URL
        accessToken: !!js process.env.DSH_AI_CODING_PLATFORM_ACCESS_TOKEN
        stateDirectory: !!js dshHomePath('ai-coding-platform')
        globalSkillRoot: !!js dshHomePath('skills')

    # Cloud-workspace Remote face: a second host-only row via the `./workspace`
    # subpath. Subpath rows never contribute a client bundle (Q2.3).
    - id: cloud-workspaces
      name: 'dsh-ai-coding/workspace'
      config:
        apiBaseUrl: !!js process.env.DSH_CLOUD_WORKSPACE_API_URL ?? process.env.DSH_AI_CODING_PLATFORM_API_URL
        accessToken: !!js process.env.DSH_CLOUD_WORKSPACE_ACCESS_TOKEN
        authMode: !!js process.env.DSH_CLOUD_WORKSPACE_AUTH_MODE
```

`!!js` is the only expression dialect `JSON_SCHEMA.extend(JsExpr)` allows. `dshHomePath` is legitimately in
scope inside config expressions:

`app-boot/lib/index.js:1530`
```js
		ctx.provide("dshHomePath", dshHomePath);
```

`package.json` — the exact additions:

```json
{
  "exports": {
    "./package.json": "./package.json"
    // ... all existing subpaths (".", "./invariant", "./workspace", "./types",
    //     "./typert", "./remote", "./client-node", "./client") stay unchanged
  },
  "files": [
    "lib/index.js",
    "lib/invariant.js",
    "lib/workspace-gateway.js",
    "lib/client.js",
    "lib/client.js.map",
    "lib/typert.host.js",
    "lib/typert.remote-client.js",
    "lib/types/**/*.js",
    "lib/types/**/*.d.ts",
    "cordis.patch.yml"
  ],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ],
      "platform": "web"
    }
  }
}
```

`dsh.bundle` and `dsh.client` coexist in the one `dsh` object without interference: `client-modules` reads
`dsh.client`, `app-boot`/`plugin` read `dsh.bundle.patch`.

The `files` array is **not cosmetic here**. The repo's `.gitignore` contains `lib/` (line 2) and there is no
`.npmignore`, so npm/pnpm pack falls back to the `.gitignore` ignore-list and would ship a tarball with **no
`lib/` at all**. Adding `files` overrides that. See "risks".

Optional: `"./cordis.patch.yml": "./cordis.patch.yml"` in `exports`. `dsh-base` and `dsh-web-app` both declare
it, but the loader reads the patch with `readFileSync(join(packageDir, declared))` (`app-boot/lib/index.js:853`),
i.e. a direct filesystem read that bypasses `exports`. Not required.

### Q1.7 `dsh.plugin.json` in this repo is not read by the CLI

- `dsh.plugin.json` does not exist anywhere under `packages/` in the reference monorepo (glob
  `packages/**/dsh.plugin.json` → no files), nor at the monorepo root.
- A ripgrep over every `*.js` in the installed 0.1.5-rc.2 `@deepseek-ai/*` tree for the literal
  `dsh.plugin.json` returned **no matches**.
- The `dsh` CLI's only manifest reads are `<profile>/package.json` (`readProfileManifest`) and each bundle's
  `package.json` (`dsh.bundle.patch`).

**Conclusion:** `C:\Users\13588\dev\dsh-ai-coding\dsh.plugin.json` with its `"mount": "cordis.patch.yml"` key is
inert. It is harmless, but it is not a mounting mechanism. (Not determined: whether some *future* or
*out-of-tree* tool consumes it — the evidence covers only the installed 0.1.5-rc.2 code.)

---

## Q2 — How the browser roster is built from a mounted package

### Q2.1 The roster is the set of live Loader rows whose package declares `dsh.client`

`client-modules/lib/index.js:66-89` (module doc, abridged)
```
 * Node half of the client module system (`dsh.client` dual-face package): scans
 * the host Loader's entries for packages declaring `dsh.client`, composes the
 * `window.__DSH_BOOT__` entry graph … in module-graph order, serves one-or-more-plugin
 * combo scripts plus their source maps, …
 *
 * Scanning is incremental per package — there is no full-rescan code path.
 * Every cordis `internal/plugin` emission (fiber construction/disposal) marks
 * the fiber's entry name dirty; a microtask flush reconciles each dirty name
 * against the live loader entries. … Package metadata (including the
 * negative "not a client package" verdict) is cached per Loader specifier and
 * owning-tree base URL until restart.
```

`client-modules/lib/index.js:775-781`
```js
	processOne(entryName, onError) {
		const nextSources = /* @__PURE__ */ new Map();
		for (const entry of this.ctx.loader.entries()) {
			if (entry.options.name !== entryName || entry.fiber === void 0 || entry.disabled) continue;
			const source = this.resolveSource(entry);
			if (source !== void 0) nextSources.set(source.sourceKey, source);
		}
```

`fiber === void 0` (failed to import) and `disabled` rows are excluded. So a **named row is required**: a
package cannot enter the roster without a loader row, and **the row id and the graph row id are both the
package name**, not the row id.

### Q2.2 The exact `dsh.client` shape

`client-modules/lib/index.js:139-153`
```js
function parseDshClient(pkgName, value) {
	if (value === void 0) return void 0;
	if (typeof value !== "object" || value === null) throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
	const decl = value;
	if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
	const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
	const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
	if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
	return {
		platform: decl.platform,
		...inject !== void 0 ? { inject } : {},
		… (external, immediately)
	};
}
```

| Key | Required | Validation | Effect |
| --- | --- | --- | --- |
| `platform` | **yes** | must be a string | row is registered **only** when it is exactly `"web"` (`:650`) |
| `inject` | no | array of strings (`optionalStringArray`, `:47-51`) | named package rows are made to arrive **before** this row in the browser |
| `external` | no | array of strings | dynamic module requests served by the module table rather than inlined |
| `immediately` | no | boolean | sets `immediately: true` on the wire row |

There is **no `entry` key**: the client entry is always discovered from `exports["./client"]`. Any other key is
ignored.

`inject` names **bare package names**, resolved against graph rows by package name:

`client-modules/lib/client.js:252-268`
```js
			/** Register each injected package and unresolved dynamic request before its consumer. */
			async arriveGraphRow(row, open = [], visited = /* @__PURE__ */ new Set()) {
				…
				for (const request of row.external) {
					const id = stripClientSuffix(request);
					if (this.seed.has(request) || this.loadCache.has(id)) continue;
					const dependency = this.graphRows.get(id);
					if (dependency !== void 0) await this.arriveGraphRow(dependency, next, visited);
				}
				for (const packageName of row.inject) {
					const dependency = this.graphRows.get(packageName);
					if (dependency !== void 0) await this.arriveGraphRow(dependency, [], visited);
				}
				await this.arrive(row);
			}
```

An `inject` name with no matching client row is silently skipped (`if (dependency !== void 0)`). Our current
`inject` list (`dsh-client-locale`, `dsh-client-ui-layout`, `dsh-client-ui-sidebar`) consists of real
first-party client rows in 0.1.5-rc.2.

### Q2.3 Mapping a row to its bundle: `exports["./client"]`, resolved from the row's package root

`client-modules/lib/index.js:637-666`
```js
	resolveMeta(loaderName, baseUrl) {
		const sourceKey = this.sourceKey(loaderName, baseUrl);
		const cached = this.pkgMeta.get(sourceKey);
		if (cached !== void 0) return cached;
		const located = this.locatePkgJson(loaderName, baseUrl);
		if (located === void 0) {
			this.pkgMeta.set(sourceKey, null);
			return null;
		}
		const { packageName, path: pkgPath } = located;
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		const dsh = pkg.dsh;
		const decl = parseDshClient(packageName, dsh !== null && typeof dsh === "object" ? dsh.client : void 0);
		if (decl === void 0 || decl.platform !== "web") {
			this.pkgMeta.set(sourceKey, null);
			return null;
		}
		const clientRel = clientExportOf(packageName, pkg.exports);
		if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
		const resolved = {
			packageName,
			meta: {
				clientPath: join(dirname(pkgPath), clientRel),
				… (inject, external, immediately)
			}
		};
		this.pkgMeta.set(sourceKey, resolved);
		return resolved;
	}
```

`client-modules/lib/index.js:155-166`
```js
/** Resolve `exports["./client"]` to a relative path, accepting the string and one-level conditional forms. */
function clientExportOf(pkgName, exportsField) {
	if (typeof exportsField !== "object" || exportsField === null) return void 0;
	const client = exportsField["./client"];
	if (client === void 0) return void 0;
	if (typeof client === "string") return client;
	if (typeof client === "object" && client !== null) {
		const fallback = client.default;
		if (typeof fallback === "string") return fallback;
	}
	throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`);
}
```

Answers:

- **Yes, always `<pkg>/client` via `exports["./client"]`.** The path is `join(packageRoot, exports["./client"])`.
  Our current `"./client": "./lib/client.js"` (plain string form) is valid.
- **`dsh.client` present but `exports["./client"]` absent is a hard throw**, not a skip.
- The bundle's own registration id must equal the **package name**, because the served URL and the graph row id
  come from the located package name. Our build already does this:
  `build/tsdown.client.ts:474` → `` banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, …` `` with
  `PACKAGE_NAME = 'dsh-ai-coding'` (`tsdown.config.ts:22`). `client.js:1` confirms the
  `window.__ModuleLoader__.load({` handoff.

### Q2.4 Subpath rows are invisible to the roster — the `name` must be a bare package specifier

`client-modules/lib/index.js:679-684`
```js
	locatePkgJson(loaderName, baseUrl) {
		if (loaderName.startsWith("cordis:")) return void 0;
		const pathLike = loaderName.startsWith(".") || loaderName.startsWith("file:") || isAbsolute(loaderName);
		const expectedPackageName = pathLike ? void 0 : exactPackageSpecifier(loaderName);
		if (!pathLike && expectedPackageName === void 0) return void 0;
```

`client-modules/lib/index.js:131-138`
```js
/** Return a bare package-root specifier, excluding package subpaths and path-like entries. */
function exactPackageSpecifier(specifier) {
	if (specifier.startsWith("@")) {
		const parts = specifier.split("/");
		return parts.length === 2 && parts.every(Boolean) ? specifier : void 0;
	}
	return specifier.length > 0 && !specifier.includes("/") ? specifier : void 0;
}
```

A row named `dsh-ai-coding/workspace` yields `exactPackageSpecifier(...) === undefined` →
`locatePkgJson` returns `undefined` → `resolveMeta` returns `null` → `resolveSource` returns `undefined` →
**the row contributes nothing to the roster and nothing is logged.** The same is true for `file:`/absolute-path
rows unless the nearest ancestor manifest name matches.

So:
- The row that carries the browser bundle **must** be the bare package name (`dsh-ai-coding`).
- A package mounted **only** via a subpath row (`dsh-ai-coding/workspace`) can never register a browser bundle
  even if its `dsh.client` exists, because the declaration is never even read for that row.

### Q2.5 Two rows naming the same package

`client-modules/lib/index.js:813-819`
```js
	reconcilePackage(packageName) {
		const sources = [];
		for (const source of this.sources.values()) if (source.packageName === packageName) sources.push(source);
		if (sources.length > 1) {
			const locations = sources.map((source) => `${JSON.stringify(source.loaderName)} from ${source.baseUrl}`).join(", ");
			throw new Error(`client-modules: package ${packageName} resolves from multiple active Loader sources: ${locations}; remove one entry`);
		}
```

Only sources that **passed** `resolveMeta` land in `this.sources`. Therefore:

- **Two bare-name rows for a `dsh.client`-declaring package ⇒ `client-modules` throws** at activation:
  `package dsh-ai-coding resolves from multiple active Loader sources: …; remove one entry`. That is a boot
  failure.
- **One bare-name row + one subpath row of the same package ⇒ no client-modules conflict** (the subpath row was
  already discarded in `locatePkgJson` before the duplicate check). This is exactly the shape the monorepo used
  (Q3).

---

## Q3 — The correct row set for the merged single package

### Q3.1 The original three-package design used exactly three rows, in one `insert` group

`…\deepseek-harness-master\packages\bundle\web-app\cordis.patch.yml:103-125`
```yaml
    # The Host owns all Team Skill service calls and local filesystem writes.
    # Browser code receives only its Typert Remote projection below.
    - id: ai-coding-platform
      name: '@deepseek-ai/dsh-ai-coding-platform'
      config:
        apiBaseUrl: !!js process.env.DSH_AI_CODING_PLATFORM_API_URL
        accessToken: !!js process.env.DSH_AI_CODING_PLATFORM_ACCESS_TOKEN
        stateDirectory: !!js dshHomePath('ai-coding-platform')
        globalSkillRoot: !!js dshHomePath('skills')

    # The cloud workspace Remote face of the same package. It is a separate row
    # because the workbench calls a different service namespace
    # (`cloudWorkspaces`) and a deployment may host it at a different endpoint
    # than the Team Skill API. …
    - id: cloud-workspaces
      name: '@deepseek-ai/dsh-ai-coding-platform/workspace'
      config:
        apiBaseUrl: !!js process.env.DSH_CLOUD_WORKSPACE_API_URL ?? process.env.DSH_AI_CODING_PLATFORM_API_URL
        accessToken: !!js process.env.DSH_CLOUD_WORKSPACE_ACCESS_TOKEN
        authMode: !!js process.env.DSH_CLOUD_WORKSPACE_AUTH_MODE
```

`…\packages\bundle\web-app\cordis.patch.yml:221-224`
```yaml
    # First-party AI Coding platform demo: login, projects, team assets, and
    # local collection views mounted through the sidebar and shell overlay.
    - id: ui-ai-coding-platform
      name: '@deepseek-ai/dsh-client-ui-ai-coding-platform'
```

Crucially, in that design the **browser bundle lived in a different package** from the two host rows. The old
published manifests confirm the split:

`C:\Users\13588\.dsh\profiles\node_modules\@deepseek-ai\dsh-ai-coding-platform\package.json` (0.1.1-rc.2) has
`exports` `"."`, `"./invariant"`, `"./types"`, `"./typert"`, `"./workspace"`, `"./remote"`, `"./src/*"`,
`"./package.json"` — and **no `"./client"` and no `dsh.client`**; no `dsh.bundle` either.

`…\@deepseek-ai\dsh-client-ui-ai-coding-platform\package.json` (0.1.1-rc.2) has `"./invariant"`, `"./client"`,
and:
```json
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar"
      ],
      "platform": "web"
    }
  },
```
(Note `@deepseek-ai/dsh-client-runtime` no longer exists in 0.1.5-rc.2; the repo's current `inject` already
dropped it. `packages/client/ui-ai-coding-platform/package.json` in the monorepo matches.)

The dual-face pattern our merged package needs is a first-party pattern, not an invention — the web-app bundle
patch mounts `dsh-client-modules` as one row that is simultaneously a host row and a roster row:

`…\dsh-web-app\cordis.patch.yml:170-177`
```
    # ── browser plugin roster (dsh.client rows; node halves are layer-2 hosts) ──

    # Dual-face: the node half scans this tree, composes window.__DSH_BOOT__,
    # and serves /plugins/<id>/client.js; the browser half is the module table
    # the shell kernel constructs before cordis exists (adopted as a plugin
    # entry by the kernel, never fetched).
    - id: modules
      name: '@deepseek-ai/dsh-client-modules'
```

### Q3.2 Verdict: **(a) two rows**

```yaml
- insert:
    - id: ai-coding-platform
      name: 'dsh-ai-coding'          # host gateway AND the single browser roster entry
      config: { … }

    - id: cloud-workspaces
      name: 'dsh-ai-coding/workspace'  # second host gateway, host-only by construction
      config: { … }
```

One sentence of justification: the bare-name row is the **only** row that can register the browser bundle
(Q2.4: subpath rows are discarded by `exactPackageSpecifier` before their `dsh.client` is read), and a second
bare-name row is actively fatal (Q2.5: `reconcilePackage` throws on two resolved sources for one package), so
the merged package needs exactly one bare-name row plus the host-only `/workspace` subpath row.

**Option (b) is wrong in both of its variants:**

- Third row naming `dsh-ai-coding` again: duplicate client source ⇒
  `client-modules: package dsh-ai-coding resolves from multiple active Loader sources: …; remove one entry`
  (boot failure). Independently, the Cordis Loader creates one fiber per entry, so the host plugin would be
  instantiated twice — for a gateway that `provide`s services this typically also fails with a duplicate-service
  error, and for one that registers event handlers or opens files it is a silent double-work bug.
- Third row naming `dsh-ai-coding/client-node`: a subpath row, therefore **no** browser registration at all
  (Q2.4), plus a third host fiber. It would only be meaningful as a genuine third *host* half, which the brief
  does not describe.

The third old row (`ui-ai-coding-platform` / `@deepseek-ai/dsh-client-ui-ai-coding-platform`) must be **deleted**
from our patch: that package does not exist in the merged repo, so the row would fail to import and
`assertEntriesLoaded` would abort boot with `plugin(s) failed to load: @deepseek-ai/dsh-client-ui-ai-coding-platform`.

---

## Q4 — First-order runtime requirements for the host half

Ordered list of what 0.1.5-rc.2 does with a row naming a third-party package.

### 4.1 The row specifier itself — **required, hard failure**

The Cordis Loader imports `entry.options.name` against the tree `baseUrl` (the profile dir, per
`prepareProfile`/`mountRootInclude`). For `dsh-ai-coding` that is `exports["."]` → `./lib/index.js`; for
`dsh-ai-coding/workspace` it is `exports["./workspace"]` → `./lib/workspace-gateway.js`.

Failure to resolve or to import leaves `entry.fiber === undefined`, and the post-settle audit aborts boot:

`app-boot/lib/index.js:1427-1440`
```js
/**
* After the tree settles, reject entries with no fiber and name every plugin
* whose module failed to resolve. Disabled entries are the only valid
* fiber-less state.
*/
function assertEntriesLoaded(ctx, binName) {
	const failed = [...ctx.loader.entries()].filter((entry) => entry.fiber === void 0 && !entry.disabled);
	if (failed.length > 0) {
		const names = failed.map((entry) => entry.options.name).join(", ");
		throw new Error(`${binName}: plugin(s) failed to load: ${names}; Cordis startup failed because these plugin(s) could not be resolved (see the error(s) logged above)`);
	}
}
```

An entry that imports but rejects or never activates is caught by `assertEntriesActivated`:
`app-boot/lib/index.js:1465-1493` (`"${binName}: ${n} entry/entries did not activate"`, naming either the thrown
stack or `pending (waiting for services: …)`).

### 4.2 `./typert` — **optional when discovered, FATAL only if explicitly listed**

`typert-loader/lib/index.js:8-17` (module doc)
```
 * When a loader entry mounts, this plugin resolves the entry's package.json; a
 * package exporting `./typert` has its host face imported and its
 * `TYPERT` manifest registered into `ctx.typert` … Explicit `packages` cover plugins nested
 * behind another Loader entry, whose Cordis fibers carry no resolvable package
 * specifier. Packages without the export are skipped silently when discovered
 * from Loader entries; an explicit package or declared artifact that is broken
 * fails loud — aggregated into this plugin's activation throw for existing
```

`typert-loader/lib/index.js:235-251`
```js
	const resolveArtifact = (pkgName) => {
		const cached = artifactPath.get(pkgName);
		if (cached !== void 0) return cached;
		let pkgPath;
		try {
			pkgPath = require.resolve(`${pkgName}/package.json`);
		} catch (cause) {
			if (configured.has(pkgName)) throw new Error(`typert-loader: configured package "${pkgName}" cannot be resolved from the config tree — add it to the composition package dependencies or remove it from packages`, { cause });
			artifactPath.set(pkgName, null);
			return null;
		}
		const rel = typertExportOf(pkgName, JSON.parse(readFileSync(pkgPath, "utf8")).exports);
		if (rel === void 0 && configured.has(pkgName)) throw new Error(`typert-loader: configured package "${pkgName}" does not export "${TYPERT_HOST_EXPORT}"`);
		const resolved = rel === void 0 ? null : join(dirname(pkgPath), rel);
		artifactPath.set(pkgName, resolved);
		return resolved;
	};
```

`typert-loader/lib/index.js:277-279`
```js
		if (registered.has(entryName) || pending.has(entryName)) return void 0;
		const path = resolveArtifact(entryName);
		if (path === null) return void 0;
```

- `./typert` **absent** → `rel === void 0` → `null` → `processOne` returns early → **silently skipped**.
  Missing `./typert` does **not** fail boot.
- `./typert` **present but broken** (import throws, or the `TYPERT` manifest is invalid) → the failure is
  collected and rethrown as an `AggregateError` at activation (`:322-326`), **failing boot**.
- If our package were named in the `typert-loader` row's `config.packages` (`Config = z.object({ packages:
  z.array(z.string().min(1)).default([]) })`, `:45-46`), a missing `./typert` would become fatal. The shipped
  `dsh-base` row mounts `@deepseek-ai/dsh-typert-loader` with **no** `config.packages`, so discovery is
  entry-driven and our `./typert` is optional. (Grep of `dsh-base/cordis.patch.yml` lines 39-43.)
- Discovery is by **entry name**, so `require.resolve('dsh-ai-coding/workspace/package.json')` fails for our
  subpath row and that row is skipped — `./typert` is only ever found through the bare-name row.

Note also `typert-loader` validates that the package **owns** its manifest:
`typert-loader/lib/index.js:78-81` requires `manifest.package === pkgName` and `manifest.face === "host"`.
Our root row is `dsh-ai-coding`, so `lib/typert.host.js` must export a `TYPERT` manifest whose `package` is
`"dsh-ai-coding"`.

### 4.3 `./invariant` — **optional, and never auto-discovered**

Nothing in the 0.1.5-rc.2 loader walks `exports["./invariant"]`. `@deepseek-ai/dsh-invariants` is a pure
registry that a companion plugin must call:

`invariants/lib/index.js:72-82`
```js
	/**
	* Register one package's invariant installer. The package name is reserved
	* even when filtering disables its checks. Enabled installers run in a child
	* fiber; failure disposes that fiber and releases the reservation.
	* @param packageName - full npm package name that owns the contribution.
	* @param installer - listener or startup-check installer for the child context.
	* @returns an effect-scoped disposer for the registration.
	*/
	register(packageName, installer) {
		if (packageName.length === 0 || packageName.trim() !== packageName || /\s/.test(packageName)) throw new Error("invariants: packageName must be non-blank and contain no whitespace");
		if (this.registrations.has(packageName)) throw new Error(`invariants: package "${packageName}" is already registered`);
```

The companion is an ordinary Cordis plugin (see `client-modules/lib/invariant.js:6-32`: `name`, `inject =
["invariants"]`, `apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))`), and it
gets mounted only by an **explicit row naming the subpath** — the shipped example is:

`dsh-sdk-minimal/cordis.patch.yml:103-116`
```yaml
    - id: invariants
      name: '@deepseek-ai/dsh-invariants'

    - id: session-invariant
      name: '@deepseek-ai/dsh-session/invariant'

    - id: agent-invariant
      name: '@deepseek-ai/dsh-agent/invariant'

    - id: scope-invariant
      name: '@deepseek-ai/dsh-scope/invariant'

    - id: agent-loop-invariant
      name: '@deepseek-ai/dsh-agent-loop/invariant'
```

(The `dsh-base` and `dsh-web-app` bundles do **not** mount any `*/invariant` row.)

- `./invariant` **missing and no row names it** → silently nothing; boot succeeds.
- `./invariant` **missing while a row names `<pkg>/invariant`** → import failure → `assertEntriesLoaded` aborts boot.
- `register()` **throws if the same package name is registered twice** (`"package … is already registered"`).
  This is a second, independent reason a duplicated row for the same package is unsafe.

Our merged package currently has `"./invariant": { "types": …, "default": "./lib/invariant.js" }` and
`tsdown.config.ts:28` builds `lib/types/invariant.js` → `lib/invariant.js`. Whether to mount it is a design
choice; **the loader will not mount it on its own.**

### 4.4 `./client` — **REQUIRED whenever `dsh.client` is declared; failure modes are loud**

Read only by `client-modules` (`:637-666` above). Three distinct outcomes:

1. No `dsh.client`, or `platform !== "web"` → row is not a client row, skipped silently (`:650-653`).
2. `dsh.client` present but `exports["./client"]` missing → **throws** at activation:
   `client-modules: <pkg> declares dsh.client but exports no "./client" bundle` (`:655`).
3. `exports["./client"]` resolves but the file is not on disk → **throws**:

`client-modules/lib/index.js:93-104, 750-763`
```js
var MissingClientBundleError = class extends Error {
	packageName;
	clientPath;
	constructor(packageName, clientPath, cause) {
		super([
			`client-modules: client bundle not found; ${CLIENT_BUNDLE_BUILD_INSTRUCTION}:`,
			`  package: ${packageName}`,
			`  path: ${clientPath}`
		].join("\n"), { cause });
```
```js
	initialBundleSnapshot(pkgName, clientPath) {
		try {
			const baseline = this.captureArtifactBaseline(clientPath);
			const bundle = readFileSync(clientPath);
			const sourceMap = this.readSourceMapSnapshot(clientPath);
			return {
				bundle,
				baseline,
				...sourceMap === void 0 ? {} : { sourceMap }
			};
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			throw new MissingClientBundleError(pkgName, clientPath, error);
		}
	}
```
with `CLIENT_BUNDLE_BUILD_INSTRUCTION = "run \`pnpm run build\` before launch"` (`:91`).

A missing **source map** is not fatal: `readSourceMapSnapshot` logs a warning and returns `undefined`
(`:765-773`, `"Treat a missing, torn, or malformed development map as an identity-mapped artifact revision"`).

### 4.5 `./types` — **not resolved by any loader code path**

Nothing under `…\@deepseek-ai\*\lib\*.js` resolves `exports["./types"]` at runtime. Every hit in the installed
tree is either a package-internal relative import (`./types.js`) or documentation. `./types` is a
**build-time/type-level** entry: host consumers of our package would import it, and the loader never does.

- `./types` missing → no boot effect whatsoever, **unless** our own runtime code imports it.
- Required only for: (a) host consumers (our own `lib/index.js` → `./types` at compile time), and (b) shipping
  runtime JS that other packages import at runtime.
- Because our `exports["./types"]` maps to `./lib/types/types.js`, we ship `lib/types/**/*.js` in `files`
  (the old published package did too: `"lib/types/**/*.js"`). That is a consumer contract, not a loader contract.

### 4.6 Q4 summary table

| Subpath | Who reads it | Missing → |
| --- | --- | --- |
| row specifier `"."` / `"./workspace"` | Cordis Loader (`entry.options.name`) | **BOOT FAILURE** (`plugin(s) failed to load`) |
| `"./typert"` | `dsh-typert-loader`, entry-name discovery | **silently skipped** (fatal only if named in `typert-loader.config.packages`; fatal if present-but-broken) |
| `"./invariant"` | nothing automatic; `dsh-invariants` registry via an explicit `<pkg>/invariant` row | **silently nothing** (fatal only if a row names it) |
| `"./client"` | `dsh-client-modules`, only when `dsh.client.platform === "web"` | **BOOT FAILURE** (`declares dsh.client but exports no "./client" bundle`, or `client bundle not found`) — but only if `dsh.client` is declared at all |
| `"./types"` | no loader code | **no boot effect**; consumer-contract only |
| `"./package.json"` | `typert-loader` `require.resolve('<pkg>/package.json')`, `client-modules` CJS fallback | fatal only for `typert-loader` when the package is explicitly listed; `app-boot` does not need it |

---

## Risks / unknowns

**High — these will break the mount as the repo stands today**

1. **`cordis.patch.yml` uses a rejected schema.** `plugins:` / `overrides:` is not a top-level array and the
   per-entry shape is not a loader patch entry. `parsePatchList` (`app-boot/lib/index.js:1199`) throws
   `${binName}: overlay <file> must be a top-level YAML array of loader patch entries`, so boot fails at
   profile load. Must be rewritten as a top-level array of `insert` / override entries.
2. **`package.json` has no `dsh.bundle`.** Without `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`,
   `dsh plugin --profile web add <path-or-tarball>` installs the dependency and then prints
   `warning: … declares no dsh.bundle — installed as a plain dependency, not a profile layer`, mounting
   nothing (`dsh/lib/plugin-Ddi42qoW.js:32, 57`).
3. **No `files` array + `.gitignore` lists `lib/`.** npm/pnpm pack falls back to `.gitignore` when there is no
   `.npmignore`, so a packed tarball would omit `lib/` entirely → the row's module cannot resolve →
   `plugin(s) failed to load`. Add `files` (Q1.6) **and** keep `cordis.patch.yml` in it.
4. **The third row still names a deleted package.** `ui-ai-coding-platform` →
   `@deepseek-ai/dsh-client-ui-ai-coding-platform` will not exist in the merged repo. That row fails to import
   and aborts the whole boot, not just itself.
5. **The two surviving rows still name the old package names.** `@deepseek-ai/dsh-ai-coding-platform` and
   `@deepseek-ai/dsh-ai-coding-platform/workspace` must become `dsh-ai-coding` and `dsh-ai-coding/workspace`,
   or the rows resolve to the stale 0.1.1-rc.2 copies still sitting in
   `C:\Users\13588\.dsh\profiles\node_modules\@deepseek-ai\` — which have no `dsh.client` and no
   `./workspace`-compatible merged code. Silent wrong-version mount is the likely symptom.
6. **`lib/` does not exist yet** (the directory is absent; the package is unbuilt). Any boot attempt before
   `pnpm build` hits `client bundle not found; run 'pnpm run build' before launch` and, for the host rows,
   `plugin(s) failed to load`.

**Medium — design decisions that are easy to get wrong**

7. **`dsh.client.inject` names must be live bare client-row package names.** They are matched against graph row
   ids (package names) in `client.js:265-267`; unmatched names are silently ignored, so a typo degrades
   ordering without any diagnostic. The current list (`dsh-client-locale`, `dsh-client-ui-layout`,
   `dsh-client-ui-sidebar`) resolves in 0.1.5-rc.2 — verify again after any baseline bump.
8. **Do not mount `./invariant` twice.** `InvariantRegistry.register` throws
   `invariants: package "dsh-ai-coding" is already registered` (`invariants/lib/index.js:82`) — a duplicate row
   fails boot. If we mount `dsh-ai-coding/invariant`, it must be exactly one row.
9. **`./typert` must be owned by the row's package name.** `typert-loader` enforces
   `manifest.package === pkgName` and `manifest.face === "host"` (`typert-loader/lib/index.js:78-81`). The row
   is `dsh-ai-coding`, so `lib/typert.host.js` must declare `package: "dsh-ai-coding"` (the old package
   declared the old name).
10. **Row id vs package name.** The graph row / `/plugins/<id>/client.js` URL id is the **package name**
    (`dsh-ai-coding`), while the loader row `id` (`ai-coding-platform`) is only a patch-addressing key. They
    need not match, but the bundle's registration id and `PACKAGE_NAME` in `tsdown.config.ts:22` must be the
    package name.
11. **`dsh.plugin.json` is dead weight.** Inert per Q1.7. Leaving it risks a future maintainer treating
    `"mount": "cordis.patch.yml"` as load-bearing.
12. **Row order carries no load semantics** (`dsh-base/cordis.patch.yml:14-15`), but *layer* order does: our
    bundle is applied after `dsh-web-app`, so a later `--patch` or `$DSH_HOME/cordis.patch.yml` layer can
    override any of our rows by id.

**Not determined from the installed code — state exactly what would settle it**

13. **Whether `"./client-node": "./lib/client-node.js"` matches the emitted path.** `tsdown.config.ts:32`
    passes the entry `lib/types/client-node/index.js` to a tsdown config with `outDir: 'lib'`. With multiple
    array entries, tsdown/rolldown derive a common root from the entries (here `lib/types`), which implies the
    artifact lands at `lib/client-node/index.js`, not `lib/client-node.js`. I could not confirm tsdown's
    entry-root rule from the installed 0.1.5-rc.2 `@deepseek-ai/*` tree (tsdown is a repo dev dependency, not
    part of the harness baseline) and did not run a build. **Settle by:** running `pnpm build` and listing
    `lib/`, then aligning `exports["./client-node"]` to the real artifact. No loader code reads
    `./client-node`, so this is currently a host-internal/consumer concern, not a boot blocker.
14. **Whether `pnpm` installing a local *directory* spec still produces a complete artifact.** With
    `nodeLinker: hoisted` and `packages: [.]` in the profile's `pnpm-workspace.yaml`
    (`C:\Users\13588\.dsh\profiles\web\pnpm-workspace.yaml:1-7`), a `file:`/path add may link the live
    checkout rather than a packed tarball, in which case the `files`/`.gitignore` interaction in risk 3 does
    not bite for path adds — but does for tarball adds. **Settle by:** inspecting
    `C:\Users\13588\.dsh\profiles\node_modules\@deepseek-ai\dsh-ai-coding` after an actual add (not run here)
    and checking whether `lib/client.js` is present.
15. **Whether anything else in the wider harness (host plugin inventory, the Plugins settings page,
    `dsh-package-manifest`, the Python wheel runtime) reads `dsh.plugin.json` or a `mount` key.** I searched
    only the installed 0.1.5-rc.2 `@deepseek-ai/*` JS tree and a `packages/**/dsh.plugin.json` glob in the
    monorepo; a monorepo-wide text search timed out at 120 s and was abandoned. **Settle by:** a
scoped ripgrep for `dsh\.plugin\.json` over `apps/`, `packages/boot/`, and `python/` in the monorepo.
16. **Whether the merged host code actually `provide`s services that would collide if the host half were
    instantiated twice.** Q3 establishes that the *loader* permits one bare + one subpath row and that a second
    bare row is fatal at the client-modules layer; whether a second identical host fiber additionally fails
    depends on our plugin's `provide` calls. **Settle by:** reading `src/index.ts` for `ctx.provide(...)` /
    `ctx.set(...)`.

---

## One-page answer

- **Q1:** A profile layer is a package listed in `<profile>/package.json` → `dsh.profile.bundles`, whose own
  `package.json` declares `dsh.bundle.patch` pointing at a **top-level YAML array** of loader patch entries.
  There is no zod/schemastery entry schema — only `yaml.JSON_SCHEMA` + the `!!js` tag plus structural checks.
  New rows **must** use `insert`; bare top-level entries are id-addressed overrides of existing rows.
  `dsh plugin add` auto-appends a bundle whose package declares `dsh.bundle.patch`. `dsh.plugin.json` is not read.
- **Q3:** **(a) two rows** — bare-name `dsh-ai-coding` (host gateway + the single browser roster entry) and
  `dsh-ai-coding/workspace` (host-only Remote face). Subpath rows are discarded before their `dsh.client` is
  read, so they can never carry the bundle; and a second bare-name row is a hard failure
  (`package dsh-ai-coding resolves from multiple active Loader sources; remove one entry`).
- **Q4:** **Required:** the row specifier itself (`exports["."]` / `exports["./workspace"]`), plus
  `exports["./client"]` **if and only if** `dsh.client.platform === "web"` is declared (a declared-but-missing
  `./client`, or a `./client` pointing at a missing file, is a boot failure). **Optional / silently skipped:**
  `./typert` (entry-discovered; fatal only if explicitly configured or present-but-broken), `./invariant`
  (never auto-discovered — needs an explicit `<pkg>/invariant` row), `./types` (no loader reads it at all),
  `./package.json` (`app-boot` explicitly does not require it).
