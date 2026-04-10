/** Dashboard HTML head and body structure. JS is appended separately. */
export const DASHBOARD_HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Ensemble</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='6' fill='%2322c55e'/></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"><\/script>
<script>tailwind.config={theme:{extend:{colors:{base:{950:'#0c0e14',900:'#141822',850:'#1a1f2e',800:'#1e2433',700:'#2a3144',600:'#3a4358'},txt:{100:'#e2e8f0',200:'#c1c9d9',300:'#8892a8',400:'#5e6a82',500:'#4a5568'}},fontFamily:{sans:['Inter','system-ui','sans-serif'],mono:['JetBrains Mono','monospace']}}}}<\/script>
<style>
@media(prefers-reduced-motion:no-preference){
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes fadein{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@keyframes hl{from{background:rgba(59,130,246,.1)}to{background:transparent}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
.pulse{animation:pulse 2s ease-in-out infinite}
.fadein{animation:fadein .25s ease-out}
.hl{animation:hl 1.5s ease-out}
.shimmer{background:linear-gradient(90deg,#22c55e 0%,#4ade80 50%,#22c55e 100%)!important;background-size:200% 100%;animation:shimmer 1.5s ease-in-out}
}
.scroll::-webkit-scrollbar{width:5px}.scroll::-webkit-scrollbar-track{background:transparent}.scroll::-webkit-scrollbar-thumb{background:#2a3144;border-radius:3px}
details summary::-webkit-details-marker{display:none}details summary{list-style:none}
select{-webkit-appearance:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%235e6a82' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center;padding-right:22px}
.xp{max-height:0;overflow:hidden;transition:max-height .3s ease-out}.xp-open{max-height:3000px;transition:max-height .5s ease-in}
.card-sel{outline:2px solid rgba(59,130,246,.4);outline-offset:1px}
.md pre{background:#1a1f2e;border:1px solid #1e2433;border-radius:6px;padding:8px 12px;overflow-x:auto;margin:6px 0;font-size:12px;line-height:1.5}
.md code{background:#1a1f2e;padding:1px 5px;border-radius:3px;font-size:12px}.md pre code{background:none;padding:0}
.md strong{color:#e2e8f0;font-weight:600}.md em{color:#c1c9d9;font-style:italic}
.md ul,.md ol{padding-left:18px;margin:4px 0}.md li{margin:2px 0}
.md h1,.md h2,.md h3{color:#e2e8f0;font-weight:600;margin:8px 0 4px}.md h1{font-size:15px}.md h2{font-size:14px}.md h3{font-size:13px}
.md a{color:#60a5fa;text-decoration:underline}.md p{margin:4px 0}
#sco{display:none;position:fixed;inset:0;background:rgba(12,14,20,.85);backdrop-filter:blur(8px);z-index:100;align-items:center;justify-content:center}
#sco.show{display:flex}
#drawer{position:fixed;top:0;right:0;bottom:0;width:min(480px,85vw);background:#141822;border-left:1px solid #1e2433;z-index:90;transform:translateX(100%);transition:transform .25s ease-out;overflow-y:auto}
#drawer.open{transform:translateX(0)}
#drawer-bg{position:fixed;inset:0;background:rgba(12,14,20,.5);z-index:89;display:none}
#drawer-bg.open{display:block}
</style>
</head>
<body class="bg-base-950 text-txt-100 min-h-screen antialiased font-sans">
<header class="fixed top-0 inset-x-0 h-11 bg-base-950/95 backdrop-blur border-b border-base-800 flex items-center justify-between px-4 z-50">
<div class="flex items-center gap-3">
<span class="font-mono font-semibold text-[13px] tracking-[.08em] text-txt-200">ensemble</span>
<span class="text-base-700">|</span>
<select id="sel" class="bg-base-900 border border-base-700 rounded-md px-2 py-[3px] text-[11px] text-txt-200 font-mono outline-none cursor-pointer hover:border-base-600 transition-colors"></select>
</div>
<div class="flex items-center gap-4">
<div id="hring" class="w-6 h-6 rounded-full" title="Team health"></div>
<div class="flex items-center gap-2">
<span id="clk" class="text-[11px] text-txt-400 font-mono"></span>
<span class="text-base-700">·</span>
<span id="cd" class="w-[7px] h-[7px] rounded-full bg-emerald-500 pulse"></span>
<span id="ct" class="text-[11px] text-txt-400 font-mono">...</span>
</div>
</div>
</header>
<div id="sum" class="fixed top-11 inset-x-0 h-8 bg-base-900/80 backdrop-blur border-b border-base-800/50 flex items-center px-4 gap-4 text-[11px] text-txt-300 z-40"></div>
<main class="pt-[76px] px-4 pb-16">
<div id="empty" class="hidden flex-col items-center justify-center h-[70vh] gap-3">
<div class="w-12 h-12 rounded-full border-2 border-base-700 flex items-center justify-center mb-2"><svg class="w-5 h-5 text-txt-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 4.5v15m7.5-7.5h-15"/></svg></div>
<div class="text-txt-400 text-sm">Waiting for a team</div>
<div class="text-txt-500 text-[11px]">Run <code class="px-1.5 py-0.5 bg-base-900 rounded text-txt-300 font-mono text-[11px]">team_create</code> in OpenCode to get started</div>
</div>
<div id="content" class="hidden">
<div id="agents" class="grid gap-2 mb-4" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))"></div>
<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
<div id="tasks" class="bg-base-900 rounded-lg p-3 border border-base-800/50"></div>
<div id="activity" class="bg-base-900 rounded-lg p-3 border border-base-800/50"></div>
</div>
</div>
</main>
<div id="tl" class="fixed bottom-0 inset-x-0 h-10 bg-base-900/90 backdrop-blur border-t border-base-800 px-4 flex items-center z-40 overflow-x-auto scroll hidden"></div>
<div id="sco" onclick="this.classList.remove('show')">
<div class="bg-base-900 border border-base-800 rounded-lg p-6 max-w-sm" onclick="event.stopPropagation()">
<div class="text-txt-200 font-semibold text-sm mb-4">Keyboard Shortcuts</div>
<div class="grid grid-cols-2 gap-y-2 gap-x-6 text-[12px]">
<div><kbd class="px-1.5 py-0.5 bg-base-800 rounded font-mono text-txt-300 text-[11px]">j</kbd> <span class="text-txt-400">Next agent</span></div>
<div><kbd class="px-1.5 py-0.5 bg-base-800 rounded font-mono text-txt-300 text-[11px]">k</kbd> <span class="text-txt-400">Prev agent</span></div>
<div><kbd class="px-1.5 py-0.5 bg-base-800 rounded font-mono text-txt-300 text-[11px]">Enter</kbd> <span class="text-txt-400">Expand agent</span></div>
<div><kbd class="px-1.5 py-0.5 bg-base-800 rounded font-mono text-txt-300 text-[11px]">Esc</kbd> <span class="text-txt-400">Collapse all</span></div>
<div><kbd class="px-1.5 py-0.5 bg-base-800 rounded font-mono text-txt-300 text-[11px]">1-9</kbd> <span class="text-txt-400">Switch team</span></div>
<div><kbd class="px-1.5 py-0.5 bg-base-800 rounded font-mono text-txt-300 text-[11px]">?</kbd> <span class="text-txt-400">This help</span></div>
</div>
</div>
</div>
<div id="drawer-bg" onclick="closeDrawer()"></div>
<div id="drawer" class="scroll p-4"></div>`;
