import ivm from "isolated-vm";

const iso = new ivm.Isolate();
const ctx = await iso.createContext();
const jail = ctx.global;
await jail.set("globalThis", jail.derefInto());

// Simulate hostCallTool
const toolCallerRef = new ivm.Reference(async (sourceId, toolName, argsJson) => {
  console.log("[HOST] callTool called:", sourceId, toolName, argsJson);
  const args = JSON.parse(argsJson);
  // Simulate async tool call
  return JSON.stringify({ success: true, result: { name: toolName, args } });
});
await jail.set("__callToolRef", toolCallerRef);

// Console log
const logRef = new ivm.Reference((...args) => {
  console.log("[SANDBOX LOG]", ...args);
});
await jail.set("__logRef", logRef);

// Setup console + namespace
const bootstrap = await iso.compileScript(`
  "use strict";
  const __stringify = (a) => typeof a === "object" && a !== null ? JSON.stringify(a, null, 2) : String(a);
  globalThis.console = {
    log: (...args) => __logRef.applySync(undefined, args.map(__stringify)),
  };
  
  globalThis.github = globalThis.github || {};
  globalThis.github.get_issue = function(args) {
    var resultJson = __callToolRef.applySyncPromise(undefined, ["github", "get_issue", JSON.stringify(args || {})]);
    var parsed = JSON.parse(resultJson);
    if (!parsed.success) throw new Error(parsed.error);
    return parsed.result;
  };
`);
await bootstrap.run(ctx);

// Result callbacks
let resolveResult;
let rejectResult;
const resultPromise = new Promise((res, rej) => {
  resolveResult = res;
  rejectResult = rej;
});
await jail.set("__resolveResult", new ivm.Reference((jsonStr) => resolveResult(jsonStr)));
await jail.set("__rejectResult", new ivm.Reference((errStr) => rejectResult(new Error(errStr))));

// User code
const wrappedCode = `
  (async function() {
    try {
      const __result = await (async function() {
        const issue = github.get_issue({ issue_number: 42 });
        console.log("Got issue:", JSON.stringify(issue));
        return issue;
      })();
      __resolveResult.applySync(undefined, [JSON.stringify({ __result: __result === undefined ? null : __result })]);
    } catch (e) {
      __rejectResult.applySync(undefined, [String(e && e.stack ? e.stack : e)]);
    }
  })()
`;

const script = await iso.compileScript(wrappedCode);

const timeoutPromise = new Promise((_, rej) => {
  setTimeout(() => rej(new Error("Timeout!")), 10000);
});
const settledPromise = Promise.race([resultPromise, timeoutPromise]);
resultPromise.catch(() => {});
timeoutPromise.catch(() => {});

script.run(ctx, { timeout: 10000 }).catch((e) => console.log("[SCRIPT.RUN ERROR]", e.message));

const resultJson = await settledPromise;
console.log("FINAL RESULT:", JSON.parse(resultJson).__result);
iso.dispose();
