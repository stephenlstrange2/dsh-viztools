window.__ModuleLoader__.load({
  id: "dsh-viztools-client-host",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    
    //#region src/client.ts
    const name = "dsh-viztools-client";
    const inject = [
    	"connection",
    	"sidebarRight",
    	"sidebarRightTabs"
    ];
    function parseSidebarStatus(value) {
    	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
    	const record = value;
    	if (typeof record.browserUrl !== "string" || typeof record.notebook !== "string" || typeof record.marimoVersion !== "string" || typeof record.processStartedAt !== "number") return void 0;
    	return {
    		browserUrl: record.browserUrl,
    		notebook: record.notebook,
    		marimoVersion: record.marimoVersion,
    		processStartedAt: record.processStartedAt
    	};
    }
    /** Resolve the secret-bearing URL over authenticated Client RPC, then open it beside the mounted Session. */
    function apply(ctx) {
    	let openedFor;
    	let openedRuntime;
    	let generation = 0;
    	const open = async () => {
    		const sessionId = ctx.sidebarRight.mounted.getSnapshot();
    		if (sessionId === void 0 || ctx.sidebarRightTabs.get("browser") === void 0) return;
    		const attempt = ++generation;
    		const response = await globalThis.fetch(`/api/viztools/sidebar-url?session=${encodeURIComponent(String(sessionId))}`, {
    			method: "GET",
    			headers: { accept: "application/json" },
    			cache: "no-store"
    		});
    		if (attempt !== generation || !response.ok) return;
    		const value = parseSidebarStatus(await response.json());
    		if (value === void 0 || ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return;
    		if (sessionId === openedFor && value.processStartedAt === openedRuntime) return;
    		ctx.sidebarRight.openTab("browser", { params: { url: value.browserUrl } });
    		openedFor = sessionId;
    		openedRuntime = value.processStartedAt;
    	};
    	const unsubscribe = ctx.sidebarRight.mounted.subscribe(() => {
    		open();
    	});
    	const reset = ctx.on("connection/reset", () => {
    		generation += 1;
    		openedFor = void 0;
    		openedRuntime = void 0;
    		open();
    	});
    	ctx.effect(() => {
    		open();
    		return () => {
    			generation += 1;
    			unsubscribe();
    			reset();
    		};
    	}, "dsh-viztools.auto-open");
    }
    
    //#endregion
    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    exports.parseSidebarStatus = parseSidebarStatus;
    return module.exports;
  },
});
//# sourceMappingURL=client.js.map
