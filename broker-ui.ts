export type BrokerRoomEntry = {
	name: string;
	displayName: string;
	role: string | null;
	state: "active" | "idle" | null;
	model: string | null;
	contextTokens: number | null;
	contextWindow: number | null;
	contextPercent: number | null;
};

function truncateAnsi(str: string, limit: number): string {
	let visibleCount = 0;
	let result = "";
	let inAnsi = false;

	for (let i = 0; i < str.length; i++) {
		const char = str[i];
		if (char === "\u001B") inAnsi = true;

		if (inAnsi) {
			result += char;
			if (char === "m") inAnsi = false;
		} else if (visibleCount < limit) {
			result += char;
			visibleCount++;
		} else {
			result += "\u001B[0m";
			break;
		}
	}
	return result;
}

function getVisibleLength(str: string): number {
	return str.replace(/\u001B\[\d+(;\d+)*m/g, "").length;
}

function fmtTokens(n: number | null): string {
	if (n === null) return "—";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

function padToWidth(line: string, width: number): string {
	const truncated = truncateAnsi(line, Math.max(0, width));
	return truncated + " ".repeat(Math.max(0, width - getVisibleLength(truncated)));
}

export function renderBrokerScreen(params: {
	width: number;
	height: number;
	rooms: Record<string, BrokerRoomEntry[]>;
	logs: string[];
	totalAgents: number;
}): string {
	const width = Math.max(20, params.width || 80);
	const height = Math.max(6, params.height || 24);
	const requestedTopHeight = Math.max(5, Math.floor(height * 0.4));
	const topHeight = Math.min(requestedTopHeight, height - 2);
	const topContentHeight = Math.max(1, topHeight - 1);
	const bottomHeight = Math.max(1, height - topHeight - 1);
	const lines: string[] = [];

	const title = " Pi2Pi Broker — Rooms & Agents ";
	const titleBar = "─".repeat(3) + title + "─".repeat(Math.max(0, width - title.length - 3));
	lines.push(`\u001B[1;36m${titleBar}\u001B[0m`);

	const roomList = Object.entries(params.rooms);
	const topLines: string[] = [];

	for (const [roomName, entries] of roomList) {
		if (topLines.length >= topContentHeight) break;
		topLines.push(padToWidth(`  \u001B[1;33m🏠 ${roomName}\u001B[0m`, width));
		if (topLines.length >= topContentHeight) break;

		const nameWidth = Math.max(...entries.map(e => e.displayName.length));
		const roleWidth = Math.max(...entries.map(e => (e.role ?? "—").length));
		const modelWidth = Math.max(...entries.map(e => (e.model ?? "—").length));
		const tokWidth = Math.max(...entries.map(e => `${fmtTokens(e.contextTokens)}/${fmtTokens(e.contextWindow)}`.length));

		for (let j = 0; j < entries.length && topLines.length < topContentHeight; j++) {
			const e = entries[j];
			const branch = j === entries.length - 1 ? "└─" : "├─";
			const isActive = e.state === "active";
			const hasState = e.state !== null;
			const stateDot = isActive ? "●" : "○";
			const stateLabel = isActive ? "active" : (hasState ? "idle  " : "?     ");
			const stateColor = isActive ? "\u001B[32m" : "\u001B[90m";
			const model = (e.model ?? "—").padEnd(modelWidth);
			const role = (e.role ?? "—").padEnd(roleWidth);
			const pct = e.contextPercent;
			const barColor = pct === null
				? "\u001B[90m"
				: pct >= 80 ? "\u001B[31m"
				: pct >= 50 ? "\u001B[33m"
				: "\u001B[32m";
			const filled = pct === null ? 0 : Math.min(8, Math.round((pct / 100) * 8));
			const bar = "█".repeat(filled) + "░".repeat(8 - filled);
			const pctStr = pct === null ? "  —%" : `${Math.round(pct)}%`.padStart(4);
			const tokStr = `${fmtTokens(e.contextTokens)}/${fmtTokens(e.contextWindow)}`.padEnd(tokWidth);
			const namePad = e.displayName.padEnd(nameWidth);

			const agentLine =
				`    \u001B[90m${branch}\u001B[0m ` +
				`\u001B[32m${namePad}\u001B[0m  ` +
				`\u001B[35m${role}\u001B[0m  ` +
				`${stateColor}${stateDot} ${stateLabel}\u001B[0m  ` +
				`\u001B[90m${model}\u001B[0m  ` +
				`${barColor}[${bar}]\u001B[0m ` +
				`${pctStr}  ` +
				`\u001B[90m(${tokStr})\u001B[0m`;
			topLines.push(padToWidth(agentLine, width));
		}
	}

	if (roomList.length === 0) topLines.push(padToWidth("  (No registered agents)", width));
	while (topLines.length < topContentHeight) topLines.push(" ".repeat(width));
	lines.push(...topLines.slice(0, topContentHeight));

	const divTitle = ` Logs (Total active agents: \u001B[1;32m${params.totalAgents}\u001B[1;36m) `;
	const visualDivTitle = divTitle.replace(/\u001B\[\d+(;\d+)*m/g, "");
	const divider = "─".repeat(3) + divTitle + "─".repeat(Math.max(0, width - visualDivTitle.length - 3));
	lines.push(`\u001B[1;36m${divider}\u001B[0m`);

	const startIndex = Math.max(0, params.logs.length - bottomHeight);
	const visibleLogs = params.logs.slice(startIndex, startIndex + bottomHeight);
	for (const logLine of visibleLogs) {
		const singleLine = logLine.replace(/\r\n|\r|\n/g, " ");
		lines.push(padToWidth(singleLine, width));
	}
	while (lines.length < height) lines.push(" ".repeat(width));

	return "\u001B[H\u001B[2J" + lines.slice(0, height).join("\n");
}
