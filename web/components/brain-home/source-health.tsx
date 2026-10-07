import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { BACKEND } from "@lib/api"
import { useAuth } from "@lib/auth-context"

type SourceHealth = { id: string; provider: string; state: string; coverage: string[];
	lastCheckedAt: number | null; lastProcessedAt: number | null; delayMs: number | null;
	stale: boolean; error: string | null }

function when(value: number | null) {
	return value === null ? "never" : new Date(value).toLocaleString()
}

export function SourceHealthPanel() {
	const { org, user } = useAuth()
	const [sourcePage, setSourcePage] = useState(0)
	const status = useQuery({
		queryKey: ["knowledge-source-health", org?.id, user?.id, sourcePage], enabled: !!org && !!user,
		queryFn: async (): Promise<{ sources: SourceHealth[]; accessCoverageIncomplete: boolean; truncated: boolean; nextSourcePage: number | null }> => {
			const response = await fetch(`${BACKEND}/brain/knowledge/sources?sourcePage=${sourcePage}`, { credentials: "include" })
			if (!response.ok) throw new Error("Source health unavailable")
			return response.json()
		}, refetchInterval: 60_000,
	})
	return <section className="rounded-[18px] bg-[#1B1F24] p-5" aria-label="Background learning health">
		<h2 className="text-[15px] font-semibold text-[#fafafa]">Background learning</h2>
		<p className="mt-1 text-[12px] text-[#a3a3a3]">Only sources you may see are shown. Connected does not mean fully covered.</p>
		{status.isPending ? <p className="mt-3 text-sm text-[#a3a3a3]">Loading source health…</p> :
			status.isError ? <p className="mt-3 text-sm text-amber-300">Source health unavailable; freshness is unknown.</p> : <>
				{(status.data.accessCoverageIncomplete || status.data.truncated) && <p className="mt-3 text-sm text-amber-300">Permission checks or source coverage are incomplete.</p>}
				{status.data.sources.length === 0 && <p className="mt-3 text-sm text-[#a3a3a3]">No verified sources yet. New connections are discovered automatically.</p>}
				<ul className="mt-3 space-y-3">{status.data.sources.map(source => <li key={source.id} className="rounded-lg bg-[#14161A] p-3">
					<div className="flex justify-between gap-3 text-sm"><span className="text-[#fafafa]">{source.provider}</span>
						<span className={source.stale ? "text-amber-300" : "text-emerald-300"}>{source.state} · {source.stale ? "coverage / freshness limited" : "processed recently"}</span></div>
					<dl className="mt-2 text-xs leading-5 text-[#a3a3a3]">
						<div>Last check: {when(source.lastCheckedAt)}</div>
						<div>Last knowledge processing: {when(source.lastProcessedAt)}</div>
						<div>Processing delay: {source.delayMs === null ? "unknown" : `${Math.ceil(source.delayMs / 60_000)} minutes`}</div>
						<div>Coverage: {source.coverage.join("; ") || "not established"}</div>
						{source.error && <div className="text-amber-300">Error: {source.error}</div>}
					</dl>
				</li>)}</ul>
				<div className="mt-3 flex gap-4 text-sm text-[#a3a3a3]">
					<button disabled={sourcePage === 0} onClick={() => setSourcePage(page => page - 1)}>Previous sources</button>
					<button disabled={status.data.nextSourcePage === null} onClick={() => setSourcePage(status.data.nextSourcePage!)}>Next sources</button>
				</div>
			</>}
	</section>
}
