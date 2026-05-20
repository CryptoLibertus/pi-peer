export function installPeerRuntimeLifecycle(pi, options = {}) {
  const runtimeFor = options.runtimeFor;
  if (!pi || typeof pi.on !== "function" || typeof runtimeFor !== "function") return false;

  pi.on("session_start", async (_event, ctx = {}) => {
    const runtime = await runtimeFor(ctx.cwd || process.cwd());
    if (runtime?.enabled && typeof runtime.start === "function") await runtime.start(ctx);
  });

  pi.on("agent_end", async (event, ctx = {}) => {
    const runtime = await runtimeFor(ctx.cwd || process.cwd());
    if (runtime?.enabled && typeof runtime.handleAgentEnd === "function") runtime.handleAgentEnd(event, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx = {}) => {
    const runtime = await runtimeFor(ctx.cwd || process.cwd());
    if (typeof runtime?.shutdown === "function") await runtime.shutdown(ctx);
  });

  return true;
}
