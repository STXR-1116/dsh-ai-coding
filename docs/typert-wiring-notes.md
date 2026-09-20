# Typert wiring notes — is the generated `./typert` artifact required, and can this repo generate it?

**Status:** findings document, evidence-driven. Written while adapting `dsh-ai-coding` (single package,
host half `src/*.ts`, browser half `src/client/*`) from the `0.1.1-rc.2` monorepo snapshot to the npm
baseline `@deepseek-ai/*@0.1.5-rc.2`.

**Nothing in this repository was modified by this investigation.** All experiments ran in
`%TEMP%\dsh-typert-ws*`; the only files written inside the repo tree were two throwaway probe copies
placed in `node_modules/.pnpm/.../dsh-typert-generator/lib/` (since deleted). `lib/` does not exist.

**Concurrent edits were visible mid-investigation** (the tree changed under me):
`tsconfig.json` now `extends: "./tsconfig.base.json"` (new file), and `package.json` gained a `files`
array. Conclusions below were re-validated against the newer revision where they depend on it.

Sources read (read-only):

| Tree | Path |
| --- | --- |
| Plugin repo | `C:\Users\13588\dev\dsh-ai-coding` |
| Local install (has the generator) | `…\dsh-ai-coding\node_modules\@deepseek-ai\` |
| Full baseline | `C:\Users\13588\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\` |
| Old monorepo (0.1.1-rc.2) | `C:\Users\13588\Downloads\deepseek-harness-master1\deepseek-harness-master` |

---

## Q1 — Is the generated `./typert` artifact required for the Host Remotes to work at runtime?

### Verdict

**(a) It works without `./typert`.** The baseline Gateway resolves a Remote endpoint through a
*strict, registry-contributed* definition first, and otherwise through a **source-mode ("SRC")
discovery fallback that reads the `@Remote` markers off the live service prototype**. No
`./typert` manifest, no `ctx.typert.register()` and no `exports["./typert"]` entry are needed for a
Host `TypertRemoteService` subclass to serve requests.

What degrades when the manifest is absent (all quoted below):

1. **No schema validation of inputs.** SRC synthesizes `codec: { mode: 'src-json' }`; `decode()` only
   calls `codec.schema.parse` when `mode === 'strict'`. A malformed payload is only rejected if it is
   not JSON.
2. **Parameter wire names come from parsing the compiled method's source text.** Destructuring,
   defaults and rest parameters make the call fail with `gateway/signature-invalid`. (Type
   annotations are irrelevant: the parse runs on compiled JS.) This repo was checked: all 85
   `@Remote` methods use bare identifier parameters — no destructuring, defaults or rest — so the SRC
   path is signature-compatible here.
3. **Cancellation** is recognized only when the final parameter is literally named `signal`.
4. `@RemoteScope(key)` requires a **runtime-registered** host Context adapter
   (`ctx.typert.contexts.registerHost`), not a manifest. This repo uses no `@RemoteScope` (0 matches
   in `src/**`).
5. **Once an endpoint has been registered and then withdrawn, SRC is forbidden**
   (`gateway/definition-unavailable`).
6. `assertExactArguments` still enforces exact wire field names — so callers must use the parameter
   names anyway.

**Conditionally hard-required — the browser half only.** `dsh-api-gateway/lib/client.js` has **no**
`remoteMethods`/SRC discovery at all (grep: 0 matches) and rejects any non-`strict` codec. So the
typed `ctx.remote.<ns>.<method>` surface needs generated `lib/typert.remote-client.js` content.
For *this* plugin that is moot: nothing in `src/**` imports `dsh-ai-coding/remote` or mentions
`TYPERT_REMOTE`/`typert` (grep: 0 matches), i.e. the browser half does not consume the generated
Remote contribution.

### Evidence

`dsh-typert-protocol/lib/index.js` — the marker and the "Visible binding":

```
 56: const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";
 64: function bindTypertRemote(service, serviceKey, options = {}) {
 65: 	validateName("service key", serviceKey);
 66: 	const namespace = options.namespace ?? serviceKey;
 68: 	return Object.freeze({ service, serviceKey, namespace });
 73: }
 74: /** Cordis Service base that exposes its registered name through Typert Gateway. */
 75: var TypertRemoteService = class extends Service {
 76: 	/** Visible binding consumed by the Gateway's source-mode discovery. */
 77: 	typertRemote;
 84: 	constructor(ctx, serviceKey, options = {}) {
 85: 		super(ctx, serviceKey);
 86: 		this.typertRemote = bindTypertRemote(this, this.name, options);
 87: 	}
 88: };
```

`@Remote` writes a frozen descriptor onto the prototype (non-enumerable own property):

```
154: function mark(prototype, method, invocation, mode, exportName) {
155: 	const descriptor = readRemoteMethodDescriptor(prototype);
156: 	const marker = Object.freeze({ method, ...exportName === void 0 || exportName === method ? {} : { exportName }, ...mode === void 0 ? {} : { mode }, invocation: Object.freeze(invocation) });
167: 	Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
168: 		configurable: true,
169: 		value: Object.freeze({ version: 1, methods: Object.freeze([...descriptor?.methods ?? [], marker]) })
173: 	});
174: }
```

`dsh-api-gateway/lib/index.js` — the **deciding branch** (registry first, SRC fallback second):

```
758: 	resolveDescriptor(namespace, method, endpoint) {
759: 		const strict = this.ctx.typert.local.get(endpoint);
760: 		if (strict !== void 0) return strict;
761: 		if (this.ctx.typert.local.hasSeen(endpoint)) throw new TypertGatewayError("gateway/definition-unavailable", endpoint, "its strict definition was withdrawn and SRC fallback is forbidden");
762: 		return this.resolveSrcDescriptor(namespace, method, endpoint);
763: 	}
764: 	resolveSrcDescriptor(namespace, method, endpoint) {
765: 		const candidates = [];
766: 		for (const [serviceKey, definition] of Object.entries(this.ctx.reflect.props)) {
767: 			if (definition.type !== "service") continue;
768: 			const receiver = this.ctx.get(serviceKey);
769: 			if (!isObject(receiver)) continue;
770: 			const original = originalOf(receiver);
771: 			const value = Reflect.get(original, "typertRemote");
772: 			if (value === void 0) continue;
773: 			const binding = readBinding(value, original, serviceKey, endpoint);
774: 			if (binding.namespace !== namespace) continue;
775: 			const marker = remoteMethods(original).find((candidate) => (candidate.exportName ?? candidate.method) === method);
776: 			if (marker === void 0) continue;
777: 			candidates.push(this.srcDescriptor(binding, marker, method, endpoint));
778: 		}
779: 		if (candidates.length === 0) throw new TypertGatewayError("gateway/invocation-unavailable", endpoint, "no active Remote method exports this endpoint");
780: 		if (candidates.length > 1) throw new TypertGatewayError("gateway/ambiguous-endpoint", endpoint, `multiple active Services export this endpoint: …`);
781: 		return candidates[0];
782: 	}
```

Answer to "unregistered package: throw, unvalidated, or work?" — **work, unvalidated**:

```
 52: // (…codec: { mode: "src-json" } is used at L799, L805, L820, L833 of srcDescriptor…)
1053: function decode(codec, value, endpoint, field) {
1054: 	try {
1055: 		if (codec.mode === "strict") {
1056: 			value = codec.schema.parse(value);
1058: 			if (value === void 0) return value;
1059: 		}
1060: 		assertJsonValue(value, /* @__PURE__ */ new Set());
1061: 		return value;
```

Endpoint claiming also has the SRC branch (so the interceptor accepts such endpoints at all):

```
510: 	claimsEndpoint(endpoint) {
511: 		if (endpoint === "$events/result") return true;
512: 		const segments = endpoint.split("/");
513: 		if (segments.length !== 2 || segments[0] === "" || segments[1] === "") return false;
514: 		if (this.ctx.typert.local.get(endpoint) !== void 0 || this.ctx.typert.local.hasSeen(endpoint)) return true;
515: 		this.srcClaims ??= this.collectSrcClaims();
516: 		return this.srcClaims.has(endpoint);
517: 	}
518: 	collectSrcClaims() {
520: 		for (const [serviceKey, definition] of Object.entries(this.ctx.reflect.props)) {
525: 			const binding = Reflect.get(original, "typertRemote");
528: 			for (const candidate of remoteMethods(original)) claims.add(endpointOf(namespace, candidate.exportName ?? candidate.method));
```

and the SRC signature constraint that produces degradation (2):

```
1010: function methodParameterNames(service, method, endpoint) {
1022: 	const source = Function.prototype.toString.call(implementation);
1023: 	const open = source.indexOf("(");
1024: 	const close = source.indexOf(")", open + 1);
1031: 	for (const part of parts) {
1032: 		if (!/^[$A-Z_a-z][$\w]*$/u.test(part) || names.has(part)) return invalidSignature(endpoint, method);
1038: 	throw new TypertGatewayError("gateway/signature-invalid", endpoint, `SRC method ${JSON.stringify(method)} must use unique identifier parameters without destructuring, defaults, or rest`);
```

`dsh-typert-loader/lib/index.js` — **the manifest is an enhancement, and it is skipped silently when absent**:

```
 40: const TYPERT_HOST_EXPORT = "./typert";
246: 		const rel = typertExportOf(pkgName, JSON.parse(readFileSync(pkgPath, "utf8")).exports);
247: 		if (rel === void 0 && configured.has(pkgName)) throw new Error(`typert-loader: configured package "${pkgName}" does not export "${TYPERT_HOST_EXPORT}"`);
248: 		const resolved = rel === void 0 ? null : join(dirname(pkgPath), rel);
278: 		const path = resolveArtifact(entryName);
279: 		if (path === null) return void 0;
280: 		const task = loadManifest(entryName, path).then((manifest) => { … registered.set(entryName, ctx.typert.register(manifest)); });
```

**But a *declared* export whose file is missing is worse than no export** — it fails loud:

```
252: 	const loadManifest = (pkgName, path) => {
255: 			loading = import(__rewriteRelativeImportExtension(pathToFileURL(path).href)).then((mod) => validateTypertManifest(pkgName, mod.TYPERT), (cause) => {
256: 				throw new Error(`typert-loader: ${pkgName} exports "${TYPERT_HOST_EXPORT}" but importing ${path} failed: ${String(cause)}`);
257: 			});
…
322: 	const failures = [];
323: 	await Promise.all(flush((err) => { failures.push(err); }));
326: 	if (failures.length > 0) throw new AggregateError(failures, `typert-loader: ${String(failures.length)} typert contributor(s) failed to register:\n…`);
```

At activation, `flush` walks every Loader entry (`L320-321`) and any failure becomes an
`AggregateError` throw; in steady state the same failure is only `ctx.logger.error(err)` (`L315-317`).
The baseline profile **does mount both plugins** —
`dsh-base/cordis.patch.yml:39-46`:

```yaml
    - id: typert
      name: '@deepseek-ai/dsh-typert-registry'
    - id: typert-loader
      name: '@deepseek-ai/dsh-typert-loader'
    - id: typert-gateway
      name: '@deepseek-ai/dsh-api-gateway'
```

**Consequence for this repo:** `package.json` currently declares
`"./typert": { types: "./lib/typert.host.d.ts", default: "./lib/typert.host.js" }` and
`"./remote": { … typert.remote-client.* }` while `lib/` does not exist. Per `loadManifest` L255-257 +
L322-326, a mounted composition that resolves this package will throw during `typert-loader`
activation. Either the artifacts must exist, or those two export entries must be removed (removal is
safe: L278-279 skips silently, and the Gateway's SRC path serves the Remotes).

`dsh-typert-registry/lib/index.js:398-418` — what a manifest actually contributes (nothing the
dispatch path needs beyond strict codecs):

```
398: 	register(contribution) {
399: 		const packageRecord = this.validatePackage(contribution);
400: 		const schemaRecords = this.validateSchemas(contribution);
401: 		const invocations = contribution.invocations;
402: 		this.localStore.validate(invocations);
405: 		return this.ctx.effect(function* () {
406: 			packages.set(packageRecord.key, packageRecord);
407: 			for (const record of schemaRecords) schemas.set(record.key, record);
408: 			localStore.commit(owner, invocations);
```

`commit` populates `entries` **and** `history` (`L87-90`), which is exactly why `hasSeen` (used at
gateway L761) forbids SRC after a withdrawal.

`dsh-api-gateway/lib/client.js` — the client half's strict-only requirement:

```
1823: 		function requireStrictDescriptor(descriptor) {
1825: 			for (const parameter of descriptor.parameters) requireStrictCodec(parameter.codec, endpoint, parameter.wire);
1828: 		function requireStrictCodec(codec, endpoint, field) {
1829: 			if (codec.mode !== "strict") throw new Error(`client api: generated Remote ${endpoint} field ${JSON.stringify(field)} has no strict codec`);
```

---

## Q2 — How do we generate the faces in a SINGLE-package repo?

### 2.1 Answer up front

**Discovery is NOT expressible for a package whose root is the repository root.** The generator
hard-filters every project reference to `<workspaceRoot>/packages/**`, and the tsdown plugin cannot
even locate a root-level package. Worse, there is a **second, independent blocker**: the analyzer only
recognizes `@Remote` / `RemoteScope` / `TypertRemoteService` when the *declaration of those symbols*
belongs to a registered workspace package literally named `@deepseek-ai/dsh-typert-protocol` — which
is impossible when the protocol is consumed from `node_modules` in a single-package repo.

So: **no `tsconfig.host.json` / `tsconfig.client.json` exists that makes the current layout work**,
and `typertPlugin(...)` emits nothing in either mode. A layout workaround (staged workspace, §2.7)
gets discovery and analysis much further, but did not complete emission in my tests; §2.8 lists what
I would do instead given the Q1 verdict.

### 2.2 The generator's three hard assumptions (quotes)

**(A1) Every registration must live under `<root>/packages/`.**
`dsh-typert-generator/lib/types/analyzer.js`:

```
300:     loadRegistrations() {
301:         const inventoryKey = `${this.options.root}\0${this.options.hostConfig}\0${this.options.clientConfig}`;
305:         for (const face of ['host', 'client']) {
307:             const aggregatePath = resolve(this.options.root, face === 'host' ? this.options.hostConfig : this.options.clientConfig);
308:             if (!existsSync(aggregatePath)) continue;
309:             const aggregate = this.caches.config(aggregatePath);
310:             for (const reference of aggregate.parsed.projectReferences ?? []) {
311:                 const configPath = projectConfigPath(reference.path);
312:                 const packageRoot = dirname(configPath);
313:                 if (!isWithin(realPath(packageRoot), join(this.options.root, 'packages'))) continue;   // ← hard filter
314:                 const manifestPath = join(packageRoot, 'package.json');
315:                 if (!existsSync(manifestPath)) continue;
```

`realPath` is `realpathSync`-based, and `isWithin` requires `<root>/packages` itself (or a child):

```
2832: function realPath(path) { … return realpathSync(absolute); }
2847: function isWithin(path, root) {
2848:     const absolute = realPath(path);
2849:     const parent = realPath(root);
2850:     return absolute === parent || absolute.startsWith(parent + sep);
2851: }
```

Consequences, exactly as asked:

* **`include`/`files` are irrelevant.** Discovery reads `projectReferences` only. The old monorepo's
  `tsconfig.host.json` confirms the shape: `"references": [{ "path": "./packages/client/ui-goal" }, …]`
  plus a long developer-only `include` list. `references` is the mechanism; `include` never
  contributes packages.
* **How a tsconfig maps back to a package**: `packageRoot = dirname(projectConfigPath(reference.path))`
  (`L311-312`; `projectConfigPath` appends `tsconfig.json` unless the path already ends in `.json`),
  the package **name** comes from that directory's `package.json` `name` field (`L315-317`).
* **There is no `**/package.json` glob** and no support for a root-level member: the only accepted
  shapes are `<root>/packages/<a>/<b>` (monorepo, two levels) or anything physically below
  `<root>/packages`. `pnpm-workspace.yaml: - .` in this repo has no bearing — the generator has its
  own notion of a workspace member.

**(A2) Remote decorators are only recognized through a workspace-owned protocol package.**
`analyzer.js`:

```
1674:     isTypeMetaSymbol(node, name) {
1678:         const resolved = this.resolveSymbol(symbol);
1679:         if (resolved.name !== name) return false;
1681:         const declaration = preferredDeclaration(resolved);
1684:         const registration = this.registrationForFile(declaration.getSourceFile().fileName);
1685:         if (registration?.name === '@deepseek-ai/dsh-typert-protocol') return true;
1687:         for (let current = declaration; current !== undefined; current = optionalParent(current)) {
1688:             if (ts.isModuleDeclaration(current) && ts.isStringLiteral(current.name)
1690:                 && current.name.text === '@deepseek-ai/dsh-typert-protocol') return true;
1692:         }
1693:         return false;
1694:     }
```

and every decorator is gated on it (bundled `lib/index.js`, `remoteMarker`):

```
847: 	remoteMarker(member) {
852: 			if (this.isTypeMetaSymbol(expression, "Remote")) marker = { kind: "direct" };
853: 			else if (ts.isCallExpression(expression) && this.isTypeMetaSymbol(expression.expression, "Remote")) {
```

`gatewayBinding` likewise requires `isTypeMetaSymbol(…, "TypertRemoteService")` (analyser `L811`), and
`registrationForFile` is a plain `isWithin` search over the registrations:

```
1918: 	registrationForFile(file) { … this.allRegistrations.find((registration) => isWithin(path, registration.root)); }
```

In the monorepo this holds because `@deepseek-ai/dsh-typert-protocol` **is** `packages/typert/protocol`
and pnpm links it into `node_modules` as a symlink, so `realpathSync` lands inside `packages/`. With a
published install the same specifier resolves into `node_modules/.pnpm/...`, which is never a
registration — see the empirical probe in §2.4.

**(A3) The tsdown plugin cannot find a root-level package, and needs `tsconfig.host.json` above the outDir.**
`lib/types/tsdown-plugin.js`:

```
 51:             const root = workspaceRoot(bundleOptions.dir);      // runs BEFORE the mode branch
 54:             if (pluginOptions.mode === 'workspace') {
 55:                 emitWorkspace(root, pluginOptions.faces);
 59:             const packageDir = packageRoot(bundleOptions.dir, root);
 60:             if (packageDir === undefined)
 61:                 return;                                            // silent no-op
121: function packageRoot(start, workspace) {
122:     let current = resolve(start);
123:     while (current !== workspace) {              // the workspace root itself is never tested
124:         if (existsSync(join(current, 'package.json'))) return current;
125:         current = dirname(current);
126:     }
127:     return undefined;
128: }
130: function workspaceRoot(start) {
131:     let current = resolve(start);
132:     while (!existsSync(join(current, 'tsconfig.host.json'))) {
133:         const parent = dirname(current);
134:         if (parent === current)
135:             throw new Error(`typert-generator: cannot find workspace root above ${start}`);
136:         current = parent;
137:     }
138:     return current;
139: }
```

* `workspaceRoot()` is called before the mode branch, so `mode: 'package'` needs
  `tsconfig.host.json` too (confirmed).
* With `outDir: "lib"`, `workspaceRoot` can only be `<repo>` (or an ancestor); then
  `packageRoot("<repo>/lib", "<repo>")` walks `lib → <repo>` and, since the loop stops *at* the
  workspace root without testing it, returns `undefined` → **`writeBundle` returns silently and emits
  nothing** for a root-level package. `mode: 'package'` cannot work here.
* `mode: 'workspace'` calls `generator.discover(faces)`, filters by `hasTypertExport`, and returns
  early when `packages.length === 0` (`L76-86`) — again silent.

**(A4) `analyze()` requires the client aggregate even when only the host face matters.**
`analyzer.js`:

```
143:     analyze() {
144:         this.registrations = this.loadRegistrations();
150:             for (const face of this.options.faces) {
151:                 const registrations = this.registrations.filter(registration => registration.face === face && …);
152:                 if (registrations.length === 0)
153:                     continue;
158:                 const aggregatePath = resolve(this.options.root, face === 'host' ? this.options.hostConfig : this.options.clientConfig);
159:                 const aggregate = this.caches.config(aggregatePath);     // ← no existsSync guard; parseConfig throws
```

`loadRegistrations` skips a missing aggregate (`L308`), but `analyze()` does not: with the default
`faces: ['host','client']` and no `tsconfig.client.json`, generation dies with
`TypertAnalysisError: Cannot read file '…/tsconfig.client.json'` (observed). Options: pass
`faces: ['host']`, or ship a `tsconfig.client.json` whose `references` list is empty (a client
aggregate that references the package registers a **client** face for it, which then requires an
`exports["./client/typert"]` plus `lib/typert.client.*` in `files` — see `validateExport` §2.6).

### 2.3 Minimal tsconfig files

**For the current (root-level package) layout: none exist.** There is no content of
`tsconfig.host.json` / `tsconfig.client.json` that makes discovery succeed, because A1 filters the
reference out no matter how the file is written. This is a hard limitation of the generator, not a
config problem.

**For a staged layout where the package really is at `<root>/packages/dsh-ai-coding`** (verified to
discover, §2.4/§2.7):

`<root>/tsconfig.host.json`:

```json
{
  "extends": "./packages/dsh-ai-coding/tsconfig.json",
  "compilerOptions": { "noEmit": true, "rewriteRelativeImportExtensions": false },
  "references": [
    { "path": "./packages/dsh-ai-coding" },
    { "path": "./packages/typert-protocol" }
  ]
}
```

* `extends` matters: the aggregate's parsed `compilerOptions` become the analysis program's options
  (`analyze` L161-168). This repo's sources import with explicit `.ts` extensions and need
  `allowImportingTsExtensions` + `moduleResolution: nodenext`, which live in `tsconfig.base.json`.
* `"noEmit": true` is **required**, not cosmetic: `allowImportingTsExtensions` without
  `noEmit`/`emitDeclarationOnly` is a config error that `parseConfig` turns into a throw
  (`analyzer.js:2382-2391`). The old monorepo's aggregate sets exactly `noEmit: true` +
  `rewriteRelativeImportExtensions: false`.
* No `include`/`files` needed (`include` in the old monorepo's aggregate covers developer-only test
  files; it plays no part in discovery).
* The second reference exists only to satisfy A2 (see §2.7).

`<root>/tsconfig.client.json`: **not needed** if the generator is called with `faces: ['host']`;
if present it must either contain no references, or the package must also publish
`./client/typert` (§2.6).

### 2.4 What actually happens — five runs

| # | Setup | Result |
| --- | --- | --- |
| 1 | `tsdown` plugin, either mode, `tsconfig.host.json` at repo root | Silent no-op (A3): `packageRoot` → `undefined`; `discover()` → `[]` |
| 2 | Script driving `WorkspaceTypertGenerator` with root = a temp dir whose `packages` is a junction to the repo's parent, reference `./packages/dsh-ai-coding` | `discover()` → `[{ package: 'dsh-ai-coding', root: '../../../../dev/dsh-ai-coding', faces: ['host'] }]` ✓ but `generate()` → `TypeError: Cannot read properties of undefined (reading 'fileName')` |
| 3 | Same as 2 with an absolute reference path | Same `TypeError` |
| 4 | Staged workspace: real copy of `package.json`/`tsconfig*.json`/`src` at `<root>/packages/dsh-ai-coding`, `node_modules` outside the package root | `discover()` ✓; `generate()` → `TypertAnalysisError: typert(host): dsh-ai-coding publishes Remote artifacts but has no Remote methods` |
| 5 | Same as 4 **plus** `@deepseek-ai/dsh-typert-protocol` materialised as `<root>/packages/typert-protocol` and resolved from there | Decorator detection now reaches the symbol (`name-ok`), then `TypeError: Cannot read properties of undefined (reading 'flags')` inside `typescript/lib/typescript.js` `getSymbolLinks` ← `getExportsOfModule` |

Diagnosis of #2/#3 (instrumented copy of the generator, logging every cache miss):

```
PROBE-MISS specifier=fflate from=…/src/installer.ts resolved=…\node_modules\.pnpm\fflate@0.8.3\node_modules\fflate\lib\node.d.cts withinRoot=true
PROBE-MISS specifier=@standard-schema/spec from=…/dsh-llm/lib/types/index.d.ts resolved=…\@standard-schema+spec@1.1.0\…\index.d.cts withinRoot=true
```

`registration.root` is the **repo root**, so `isWithin(resolvedPath, registration.root)` accepts every
path under `node_modules`. `reachableFiles` then does
`queue.push(this.sourceFiles.get(resolvedPath))` (bundled `lib/index.js:533`) with no guard and
pushes `undefined` for resolved files the program never loaded → the crash at `L526`
(`realPath(sourceFile.fileName)`). The same defect makes `registrationForFile` claim `node_modules`
files as package-owned: after the misses were skipped, run #3 died with
`TypertAnalysisError: typert(host): …/@deepseek-ai/dsh-llm/lib/types/types.d.ts:57:17: type symbol
unknown has no declaration` — i.e. the analyzer was modelling `dsh-llm`'s internals as this package's
own types (the missing `@deepseek-ai/dsh-attachment` type `ImageAttachmentRef` then has no
declaration).

**This is why a package rooted at the repository root cannot be analyzed at all** — even if discovery
were bypassed.

Diagnosis of #4 (instrumented `isTypeMetaSymbol` / `remoteMarker`):

```
PROBE-COLLECT name=dsh-ai-coding reachable=24
PROBE-RM member=login exprText=Remote('login') isRemote=false isRemoteCall=false registrationOfDecl="nosym"
PROBE-ITYPEMETA name=Remote node=Remote => name-ok reg=NONE file=…/node_modules/.pnpm/@deepseek-ai+dsh-typert-pro_…/node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/index.d.ts
```

So `Remote` *is* resolvable and correctly named — but the owning registration is `NONE`, because the
declaration comes from the pnpm store. With zero markers, `collectInvocations` returns `[]`
(`collectInvocations`, bundled `L673-693`), `emitter.emit` therefore omits `remote`
(`emitter.js:47-49`), and `validateExport` throws because the manifest publishes `./remote`:

```
 98:         const remoteFiles = [ 'lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts' ];
102:         if (artifact.remote === undefined) {
103:             if (remoteActual !== undefined || remoteFiles.some(file => files.includes(file))) {
104:                 throw new TypertAnalysisError(`typert(host): ${artifact.package} publishes Remote artifacts but has no Remote methods`);
105:             }
```

Run #5 shows the A2 workaround is at least partially effective (the decorator is recognized once the
protocol's real path is under `<root>/packages`), but it then failed inside TypeScript's checker
(`getSymbolLinks` reading `'flags'` of `undefined` via `getExportsOfModule`). **Not determined:**
whether that crash is intrinsic (two module identities for the protocol: the staged copy plus the
pnpm copy pulled in by other dependencies) or avoidable with a fully self-contained staged workspace
(staging *every* dependency, or mapping the specifier with `compilerOptions.paths` to the staged
copy). What would settle it: run #5 with `paths: { "@deepseek-ai/dsh-typert-protocol": ["…/packages/typert-protocol/lib/index.js"] }`
in the aggregate so exactly one copy exists in the program.

### 2.5 The exact `typertPlugin` call (and why it emits nothing here)

`typertPlugin` accepts `{ mode?: 'package' | 'workspace', faces?: readonly TypertFace[] }`
(`tsdown-plugin.d.ts:20-32`). It must be attached to the **node-half** config — the dev output whose
`outDir` is `<repo>/lib`. In this repo that config is built by `clientBundle(...)` in
`build/tsdown.client.ts`, which spreads an `overrides` object into the node-half user config
(`build/tsdown.client.ts:242`), so the literal call would be:

```ts
// tsdown.config.ts — third argument of clientBundle(...) is the node-half override
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

export default clientBundle(PACKAGE_NAME, [
  'lib/types/index.js',
  'lib/types/invariant.js',
  'lib/types/workspace-gateway.js',
  'lib/types/client-node/index.js',
  'lib/types/client-node/invariant.js',
], {
  lib: {
    plugins: [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  },
})
```

* `mode: 'workspace'` is the only mode that could ever emit here (see A3); `mode: 'package'` returns
  before doing anything because the package *is* the workspace root.
* `faces: ['host']` is required in practice: without it the client face is analyzed and the emitted
  client artifact makes `validateExport` demand `exports["./client/typert"]` + `lib/typert.client.*`
  in `files` (`workspace.js:86-115`); it also forces `tsconfig.client.json` to exist (A4).
* **With the current layout this call is a no-op**: `discover()` returns `[]` (A1), so
  `emitWorkspace` hits `if (packages.length === 0) return;` (`tsdown-plugin.js:81-82`). It cannot be
  salvaged by options — `packages`/`faces` do not exist on `TypertPluginOptions`, and even an
  explicit package list is filtered out by `loadRegistrations` (A1) before selection happens.

### 2.6 `package.json` requirements

`validateExport` (`workspace.js:66-116`) requires, for the host face:

```js
 69:         const subpath = artifact.face === 'host' ? './typert' : './client/typert';
 70:         const expected = { types: `./lib/typert.${artifact.face}.d.ts`, default: `./lib/typert.${artifact.face}.js` };
 77:         if (!sameExport(actual, expected)) throw new TypertAnalysisError(`typert(${artifact.face}): ${artifact.package} must export ${subpath} as ${JSON.stringify(expected)}`);
 80:         const files = Array.isArray(manifest.files) ? manifest.files : [];
 81:         for (const file of [`lib/typert.${artifact.face}.js`, `lib/typert.${artifact.face}.d.ts`]) {
 82:             if (!files.includes(file)) throw new TypertAnalysisError(`typert(${artifact.face}): ${artifact.package} package files must include ${file}`);
 ...
 88:         const remoteExpected = { types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' };
108:         if (!sameExport(remoteActual, remoteExpected)) throw new TypertAnalysisError(`typert(host): ${artifact.package} must export ./remote as ${JSON.stringify(remoteExpected)}`);
111:         for (const file of remoteFiles) { if (!files.includes(file)) throw new TypertAnalysisError(`typert(host): ${artifact.package} package files must include ${file}`); }
```

State of this repo (verified): all four exports already exist —
`"./typert"` → `./lib/typert.host.{d.ts,js}`, `"./remote"` → `./lib/typert.remote-client.{d.ts,js}`,
`"./types"` → `./lib/types/types.{d.ts,js}` — and the `files` array now contains all four typert
paths (it was absent earlier in the investigation; the two `types` files land through `"lib"`).
`"./client/typert"` is correctly **absent** as long as the client face is excluded with
`faces: ['host']`.

### 2.7 The `dsh-ai-coding/types` specifier question — YES

The emitted declaration files import this package's own types through its **public subpath
specifiers**, built as `packageName + subpath`:

`emitter.js`:

```
736: function packageExportSpecifier(packageName, subpath) {
737:     return subpath === '.' ? packageName : `${packageName}${subpath.slice(1)}`;
738: }
```

```
242:     renderRemoteDts(packageModel) {
243:         const imports = remoteImports(packageModel.invocations);
262:         for (const [specifier, values] of [...grouped].sort(…)) {
264:             lines.push(`import type { ${names.join(', ')} } from ${quote(specifier)}`);
```

and which subpath is chosen is decided by `publicRemoteType` (`analyzer.js:1633-1666`):

```
1641:         for (const [subpath, target] of packageExportTargets(registration.manifest)) {
1642:             if ((subpath === '.' && !PUBLIC_REMOTE_TYPE_ROOTS.has(registration.name))
1643:                 || subpath === './package.json' || subpath === './typert'
1644:                 || subpath === './client/typert' || subpath === './remote' || target.includes('*'))
1645:                 continue;
1657:                     specifier: packageExportSpecifier(registration.name, subpath),
1662:         const selected = candidates.sort((left, right) => left.specifier.localeCompare(right.specifier) || left.name.localeCompare(right.name))[0];
1664:             this.fail(site, `Remote boundary type ${symbol.name} must be exported from a public non-root type subpath`);
```

with `PUBLIC_REMOTE_TYPE_ROOTS = new Set(['@deepseek-ai/dsh-util-values'])` (`analyzer.js:10-12`).
Therefore:

* For a Remote boundary type exported from `src/types.ts` via `"./types"`, the generated
  `typert.remote-client.d.ts` and `typert.host.d.ts` contain
  `import type { … } from 'dsh-ai-coding/types'`.
* This package **must** keep publishing `"./types"` (it does), and self-reference resolution must
  work, i.e. `exports` must be present and `lib/types/types.d.ts` must exist when consumers
  type-check the generated declarations — true after `tsc -p tsconfig.json` (which emits
  `src/types.ts → lib/types/types.d.ts`).
* Types reachable **only** through the root `.` export are rejected outright with
  `Remote boundary type X must be exported from a public non-root type subpath` — a real constraint
  for this repo's 85 Remote methods (they use `./types.ts`, `./workspace-types.ts` aliases exported
  through `./types`, so they are fine in principle).
* `lib/types/*.d.ts` also feeds `sourcePathForExport` (`analyzer.js:2513-2521`), which maps
  `lib/types/x.d.ts → src/x.ts`; the current `outDir: "lib/types"` layout is exactly what that
  function expects.

### 2.8 If you still want the artifacts: the workaround, literally

Two files, both outside the repo (they never touch the plugin sources):

`%TEMP%\typert-stage\build-stage.mjs` — build a shadow workspace whose `packages/` holds a **real
copy** of this package (so `node_modules` is outside `registration.root`) plus a real copy of the
protocol (so A2 can be satisfied):

```js
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const repo = 'C:/Users/13588/dev/dsh-ai-coding'
const stage = process.argv[2]
rmSync(stage, { recursive: true, force: true })
const pkgDir = join(stage, 'packages', 'dsh-ai-coding')
mkdirSync(pkgDir, { recursive: true })
cpSync(join(repo, 'src'), join(pkgDir, 'src'), { recursive: true })
for (const file of ['tsconfig.json', 'tsconfig.base.json']) cpSync(join(repo, file), join(pkgDir, file))
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
manifest.files = ['lib/typert.host.js', 'lib/typert.host.d.ts', 'lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts']
writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
// A2: the protocol must be a workspace package under <root>/packages, and must be reached there.
// dereference:true matters — cpSync otherwise copies pnpm's symlink and realpathSync stays in .pnpm.
const protoSrc = join(repo, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol')
cpSync(protoSrc, join(stage, 'packages', 'typert-protocol'), {
  recursive: true, dereference: true,
  filter: (p) => !p.slice(protoSrc.length).includes('node_modules'),
})
writeFileSync(join(stage, 'packages', 'typert-protocol', 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true } }, null, 2) + '\n')
// staged node_modules for the package: junctions, with the protocol pointing at the staged copy
const nm = join(pkgDir, 'node_modules')
mkdirSync(nm, { recursive: true })
const link = (target, at) => symlinkSync(target, at, 'junction')
for (const entry of readdirSync(join(repo, 'node_modules'))) {
  if (entry.startsWith('.')) continue
  const from = join(repo, 'node_modules', entry)
  if (entry.startsWith('@')) {
    const scoped = join(nm, entry)
    mkdirSync(scoped, { recursive: true })
    for (const inner of readdirSync(from)) {
      if (entry === '@deepseek-ai' && inner === 'dsh-typert-protocol') continue
      link(join(from, inner), join(scoped, inner))
    }
  } else link(from, join(nm, entry))
}
link(join(stage, 'packages', 'typert-protocol'), join(nm, '@deepseek-ai', 'dsh-typert-protocol'))
link(join(repo, 'node_modules'), join(stage, 'node_modules'))
mkdirSync(join(pkgDir, 'lib'), { recursive: true })
writeFileSync(join(stage, 'tsconfig.host.json'), JSON.stringify({
  extends: './packages/dsh-ai-coding/tsconfig.json',
  compilerOptions: { noEmit: true, rewriteRelativeImportExtensions: false },
  references: [{ path: './packages/dsh-ai-coding' }, { path: './packages/typert-protocol' }],
}, null, 2) + '\n')
console.log('STAGE BUILT')
```

`%TEMP%\typert-stage\gen.mjs` — drive the generator (the package root's `"."` export is
`lib/index.js`, which does export `WorkspaceTypertGenerator`; `lib/types/*` is not reachable through
the package `exports`, so import the bundle by URL):

```js
import { WorkspaceTypertGenerator } from 'file:///C:/Users/13588/dev/dsh-ai-coding/node_modules/@deepseek-ai/dsh-typert-generator/lib/index.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.argv[2]
const FACES = ['host']                                   // A4: host only
const generator = new WorkspaceTypertGenerator(root, { checkDiagnostics: false })  // build already ran tsc
const discovered = generator.discover(FACES)             // sanity: must list dsh-ai-coding
console.log('DISCOVERED=' + JSON.stringify(discovered))
const artifacts = generator.generate(undefined, FACES)
for (const a of artifacts) {
  const out = join(root, a.packageRoot, 'lib')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `typert.${a.face}.js`), a.js)
  writeFileSync(join(out, `typert.${a.face}.d.ts`), a.dts)
  if (a.remote !== undefined) {
    writeFileSync(join(out, 'typert.remote-client.js'), a.remote.js)
    writeFileSync(join(out, 'typert.remote-client.d.ts'), a.remote.dts)
    writeFileSync(join(out, 'typert.remote-client.d.ts.map'), a.remote.dtsMap)
  }
}
console.log('ARTIFACTS=' + JSON.stringify(artifacts.map(a => ({ pkg: a.package, face: a.face, hasRemote: a.remote !== undefined }))))
```

then copy `%TEMP%\typert-stage\packages\dsh-ai-coding\lib\typert.*` back into `<repo>/lib/`.

**Honest status: this recipe is not proven to work end-to-end.** It fixes the
`packages/` filter (A1) and the `node_modules`-inside-package defect, gets discovery and the
decorator path right (run #5), and then fails inside the TypeScript checker
(`getSymbolLinks`/`getExportsOfModule`) — root cause not determined. Because it copies sources, the
generated `typert.remote-client.d.ts.map` and `sourceLocation` entries would also point at staging
paths.

### 2.9 Recommended action, given Q1

1. **Do not chase generation in this layout.** The gateway serves all 85 Remotes over SRC without it
   (Q1), and the browser half does not import `./remote`.
2. **Either ship the four files or delete the two export entries.** With `lib/` absent,
   `"./typert"` is a loaded gun: `typert-loader` throws an `AggregateError` at activation for every
   mounted entry whose declared artifact cannot be imported (`index.js:255-257`, `322-326`), and
   `dsh-base` mounts that plugin (`cordis.patch.yml:42-43`). Removing `"./typert"`/`"./remote"` is
   the low-risk option (`index.js:278-279` skips silently) and keeps SRC dispatch working; if the
   artifacts are ever produced, re-add the exports together with the `files` entries.
3. If validated Remotes (zod codecs, optional inputs, strict argument checking) are genuinely
   required, the only path with known-good semantics is the monorepo shape: the package as
   `<root>/packages/dsh-ai-coding` **and** `@deepseek-ai/dsh-typert-protocol` resolvable to a real
   path under `<root>/packages` (that is what makes A2 satisfied in the harness). Until that is
   proven with run #5 finished, treat generation as unavailable.

---

## Risks / unknowns / not determined

* **Run #5's TypeScript checker crash** (`getSymbolLinks` / `getExportsOfModule`) — not determined
  whether it is a property of the generator, of my staged duplicate-protocol setup, or of something
  in this repo's type graph. Settling it needs a single-copy staging (e.g. `compilerOptions.paths`
  mapping the protocol to the staged copy) or an actual monorepo-shaped layout.
* **`ctx.reflect.props` population** (the SRC discovery source, gateway L520/L766) was not traced
  through cordis: it is the one prerequisite of the SRC path verified only at its call sites.
* **No live boot was performed.** All Q1 conclusions are static-code reading of the 0.1.5-rc.2
  baseline; the SRC path is proven by code paths, not by an observed call.
* **Whether `typert-loader` resolves this package at all** is unresolved: `resolveArtifact` uses
  `require.resolve(\`${pkgName}/package.json\`)` from the config tree (`index.js:239-245`), and this
  repo's `cordis.patch.yml` still mounts the *old* monorepo names
  (`@deepseek-ai/dsh-ai-coding-platform[ /workspace]`), not `dsh-ai-coding`. If the name cannot be
  resolved, the declared-but-missing `./typert` would be skipped silently (`index.js:243-244`) rather
  than throw — which lowers, but does not remove, the risk in §2.9/2.
* **`checkDiagnostics` was disabled in all experiments** (matching the tsdown plugin's
  `TSC_VERIFIED_INPUT`, `tsdown-plugin.js:16`). Whether the repo's 85 Remote methods satisfy the
  generator's check-mode annotation requirements was **not determined** — it would need a run with
  `checkDiagnostics: true` (or `mode: 'write'`) on a layout where emission gets that far.
* **Missing type dependency**: `@deepseek-ai/dsh-attachment` (needed by `dsh-llm`'s
  `ImageAttachmentRef`) is not in this repo's dependency tree. It only surfaced because the analyzer
  mis-claimed `node_modules` as package-owned; a correct layout may or may not need it.
* **Concurrent edits**: `tsconfig.base.json` (new), the `package.json` `files` array and
  `dev/**` test files changed while this was being written; re-verify line numbers/contents before
  acting on anything above.
* `PUBLIC_REMOTE_TYPE_ROOTS` currently contains only `@deepseek-ai/dsh-util-values`; if a future
  Remote boundary type needs the root `"."` export, emission fails by design (analyzer `L1664`).
