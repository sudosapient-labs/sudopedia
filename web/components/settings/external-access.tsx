import { useEffect, useRef, useState } from "react"
import { useAuth } from "@lib/auth-context"
import { Button } from "@ui/components/button"
import { Input } from "@ui/components/input"

type Credential = {
	id: string
	label: string
	kind: "personal" | "organization" | "employee"
	grants: string[]
	expiresAt: number
	revokedAt: number | null
}
type Listing = {
	credentials: Credential[]
	mcpUrl: string
	maxLifetimeDays: number
	employeeConnectionsEnabled: boolean
	nextCursor?: { id: string; asOf: number; version: string } | null
}
const personalGrants = [
	"memory.shared:read",
	"memory.personal:read",
	"memory.personal:write",
]
const ordinaryGrants = [...personalGrants, "memory.private-channel:read"]
const privilegedGrants = ["memory.shared:write", "skills.org:read"]
const grantLabels: Record<string, string> = {
	"memory.shared:read": "Read shared company knowledge",
	"memory.personal:read": "Read own personal memory",
	"memory.personal:write": "Write own personal memory",
	"memory.private-channel:read": "Read permitted private-channel knowledge",
	"memory.shared:write": "Write shared company memory (owner/admin only)",
	"skills.org:read": "Read organization skills (owner/admin only)",
}

export default function ExternalAccess() {
	const { isAdmin, org, user } = useAuth()
	const generation = useRef(0)
	const listingRequest = useRef(0)
	const loading = useRef(false)
	const grants = isAdmin ? [...ordinaryGrants, ...privilegedGrants] : ordinaryGrants
	const [listing, setListing] = useState<Listing | null>(null)
	const [label, setLabel] = useState("")
	const [days, setDays] = useState(7)
	const [selected, setSelected] = useState<string[]>([...personalGrants])
	const [consent, setConsent] = useState(false)
	const [secret, setSecret] = useState<string | null>(null)
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const [loadingPage, setLoadingPage] = useState(false)
	const endpoint = "/brain/external-credentials/"
	const refresh = async () => {
		const current = generation.current
		const request = ++listingRequest.current
		const response = await fetch(endpoint, {
			credentials: "include",
			cache: "no-store",
		})
		const body = await response.json()
		if (!response.ok)
			throw new Error(body.error?.message ?? "Unable to load credentials")
		if (current === generation.current && request === listingRequest.current) setListing(body)
	}
	const loadMore = async () => {
		if (!listing?.nextCursor || loading.current || busy) return
		const current = generation.current, request = ++listingRequest.current
		loading.current = true
		setLoadingPage(true)
		setError("")
		try {
			const response = await fetch(`${endpoint}list`, {
				method: "POST", credentials: "include", cache: "no-store",
				headers: { "Content-Type": "application/json", "X-Sudopedia-CSRF": "1" },
				body: JSON.stringify({ cursor: listing.nextCursor }),
			})
			const body: Listing & { error?: { message?: string } } = await response.json()
			if (!response.ok) throw new Error(body.error?.message ?? "Unable to load credentials")
			if (current === generation.current && request === listingRequest.current)
				setListing((previous) => previous ? { ...body, credentials: [...new Map(
					[...previous.credentials, ...body.credentials].map((row) => [row.id, row]),
				).values()] } : body)
		} catch (e) {
			if (current === generation.current && request === listingRequest.current)
				setError(e instanceof Error ? e.message : "Unable to load credentials")
		} finally {
			if (current === generation.current) { loading.current = false; setLoadingPage(false) }
		}
	}
	useEffect(() => {
		generation.current++
		setSecret(null)
		setListing(null)
		setConsent(false)
		setSelected([...personalGrants])
		setBusy(false)
		loading.current = false
		setLoadingPage(false)
		setError("")
		const current = generation.current
		if (user && org) void refresh().catch((e) => {
			if (current === generation.current) setError(e.message)
		})
		return () => {
			generation.current++
		}
	}, [isAdmin, org?.id, user?.id])
	const mutate = async (path: string, body: unknown) => {
		const current = generation.current
		setBusy(true)
		setError("")
		setSecret(null)
		listingRequest.current++ // Fence an older page response before a mutation.
		try {
			const response = await fetch(path, {
				method: "POST",
				credentials: "include",
				cache: "no-store",
				headers: {
					"Content-Type": "application/json",
					"X-Sudopedia-CSRF": "1",
				},
				body: JSON.stringify(body),
			})
			const result = await response.json()
			if (!response.ok)
				throw new Error(result.error?.message ?? "Operation failed")
			if (current !== generation.current) return
			if (result.secret) setSecret(result.secret)
			await refresh()
		} catch (e) {
			if (current === generation.current)
				setError(e instanceof Error ? e.message : "Operation failed")
		} finally {
			if (current === generation.current) setBusy(false)
		}
	}
	if (!user || !org)
		return (
			<p className="text-sm text-[#8B929E]">
				Sign in to manage your personal integrations.
			</p>
		)
	return (
		<div className="space-y-5 text-sm text-[#FAFAFA]">
			<p className="rounded-lg border border-amber-500/30 p-4 text-amber-100">
				Your primary bot can receive permitted company and personal knowledge
				and, with your personal-write consent, persist new facts, change
				preferences and retract incorrect memories in your personal brain. It
				can read ingested private-channel knowledge only with your grant and
				verified current Slack membership. Owners/admins may additionally grant
				shared writes and organization-skill reads on this same connection.
				Personal is the default: shared writes must be explicitly directed to
				company memory, even in a DM. It cannot access another employee’s
				personal memory or run actions. Revocation stops future operations;
				downloaded context cannot be recalled.
			</p>
			<p>
				Remember only durable preferences, responsibilities and plans—not every
				message. Tell your bot “do not remember this”, “I now own billing rather
				than onboarding”, or “that preference was wrong; stop using it” to
				prevent capture or correct/retract personal knowledge. The bot must
				invoke memory tools; automatic capture depends on its configuration.
			</p>
			{listing && (
				<p>
					MCP connection URL:{" "}
					<code className="break-all">{listing.mcpUrl}</code>
				</p>
			)}
			{error && (
				<p role="alert" className="text-red-400">
					{error}
				</p>
			)}
			{secret && (
				<div className="space-y-2 rounded-lg border border-white/20 p-4">
					<p>
						Copy this credential now. It is shown once and is not saved in your
						browser.
					</p>
					<textarea
						aria-label="One-time bearer credential"
						readOnly
						value={secret}
						className="w-full break-all rounded bg-black/20 p-2 font-mono"
					/>
					<Button
						type="button"
						variant="outline"
						onClick={() => setSecret(null)}
					>
						Dismiss secret
					</Button>
				</div>
			)}
			{listing && !listing.employeeConnectionsEnabled && <p>New employee connections are not enabled yet. Existing credentials remain manageable.</p>}
			{listing?.employeeConnectionsEnabled && <form
				className="space-y-4"
				onSubmit={(event) => {
					event.preventDefault()
					void mutate(endpoint, {
						kind: "employee",
						label,
						grants: selected,
						expiresInDays: days,
						consent,
					})
				}}
			>
				<label className="block">
					Integration label
					<Input
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						required
						maxLength={100}
						autoComplete="off"
					/>
				</label>
				<label className="block">
					Expires in days (maximum {listing?.maxLifetimeDays ?? 365})
					<Input
						type="number"
						min={1}
						max={listing?.maxLifetimeDays ?? 365}
						value={days}
						onChange={(e) => setDays(Number(e.target.value))}
						required
					/>
				</label>
				<fieldset disabled={busy}>
					<legend>Explicit read/write grants</legend>
					{grants.map((grant) => (
						<label key={grant} className="mr-5 inline-flex items-center gap-2">
							<input
								type="checkbox"
								aria-label={grant}
								checked={selected.includes(grant)}
								onChange={(e) => {
									setConsent(false)
									setSelected((current) =>
										e.target.checked
											? [...current, grant]
											: current.filter((g) => g !== grant),
									)
								}}
							/>
							{grantLabels[grant]}
						</label>
					))}
				</fieldset>
				<label className="flex items-start gap-2">
					<input
						type="checkbox"
						checked={consent}
						required
						onChange={(e) => setConsent(e.target.checked)}
					/>
					I authorize this employee-owned bot/provider to receive the selected
					knowledge and perform selected personal writes without a Slack approval
					for each routine write. If I select shared-write access, I also authorize
					explicitly directed company-memory captures, corrections and retractions;
					this does not authorize publishing all conversation content. Skill
					access retrieves instructions, not permission to execute them.
				</label>
				<Button
					type="submit"
					disabled={busy || !listing || !consent || !selected.length}
				>
					Create credential
				</Button>
			</form>}
			<ul className="space-y-3">
				{listing?.credentials.map((credential) => (
					<li
						key={credential.id}
						className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 p-3"
					>
						<div>
							<p>
								{credential.label} ·{" "}
								{credential.kind === "employee"
									? "Employee bot connection"
									: credential.kind === "personal"
									? "Personal integration"
									: "Organization integration"}
							</p>
							<p className="text-xs text-[#8B929E]">
								{credential.grants.join(", ")} · expires{" "}
								{new Date(credential.expiresAt).toLocaleString()} ·{" "}
								{credential.revokedAt
									? "revoked"
									: credential.expiresAt <= Date.now()
										? "expired"
										: "active"}
							</p>
						</div>
						<Button
							type="button"
							variant="outline"
							disabled={busy || !!credential.revokedAt}
							onClick={() => {
								if (
									window.confirm(
										`Revoke ${credential.label}? Future reads and writes will be denied.`,
									)
								)
									void mutate(`${endpoint}${credential.id}/revoke`, {})
							}}
						>
							Revoke
						</Button>
					</li>
				))}
			</ul>
			{listing?.nextCursor && (
				<Button type="button" variant="outline" disabled={busy || loadingPage} onClick={() => void loadMore()}>
					{loadingPage ? "Loading credentials…" : "Load more credentials"}
				</Button>
			)}
			<Button type="button" variant="outline" disabled={busy || loadingPage} onClick={() => {
				const current = generation.current
				setError("")
				void refresh().catch((e) => { if (current === generation.current) setError(e.message) })
			}}>Reload credentials</Button>
		</div>
	)
}
