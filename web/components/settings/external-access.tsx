import { useEffect, useRef, useState } from "react"
import { useAuth } from "@lib/auth-context"
import { Button } from "@ui/components/button"
import { Input } from "@ui/components/input"

type Credential = {
	id: string
	label: string
	kind: "personal" | "organization"
	grants: string[]
	expiresAt: number
	revokedAt: number | null
}
type Listing = {
	credentials: Credential[]
	mcpUrl: string
	maxLifetimeDays: number
}
const personalGrants = [
	"memory.shared:read",
	"memory.personal:read",
	"memory.personal:write",
]
const organizationGrants = ["memory.shared:read", "skills.org:read"]

export default function ExternalAccess() {
	const { isAdmin, org, user } = useAuth()
	const generation = useRef(0)
	const [kind, setKind] = useState<"personal" | "organization">("personal")
	const grants = kind === "personal" ? personalGrants : organizationGrants
	const [listing, setListing] = useState<Listing | null>(null)
	const [label, setLabel] = useState("")
	const [days, setDays] = useState(7)
	const [selected, setSelected] = useState<string[]>([...personalGrants])
	const [consent, setConsent] = useState(false)
	const [secret, setSecret] = useState<string | null>(null)
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const endpoint = "/brain/external-credentials/"
	const refresh = async () => {
		const current = generation.current
		const response = await fetch(endpoint, {
			credentials: "include",
			cache: "no-store",
		})
		const body = await response.json()
		if (!response.ok)
			throw new Error(body.error?.message ?? "Unable to load credentials")
		if (current === generation.current) setListing(body)
	}
	useEffect(() => {
		generation.current++
		setSecret(null)
		setListing(null)
		setConsent(false)
		setKind("personal")
		setSelected([...personalGrants])
		if (user && org) void refresh().catch((e) => setError(e.message))
		return () => {
			generation.current++
		}
	}, [isAdmin, org?.id, user?.id])
	const mutate = async (path: string, body: unknown) => {
		const current = generation.current
		setBusy(true)
		setError("")
		setSecret(null)
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
				cannot write shared knowledge, access private channels or another
				employee’s memory, or run actions. Revocation stops future operations;
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
			<form
				className="space-y-4"
				onSubmit={(event) => {
					event.preventDefault()
					void mutate(endpoint, {
						kind,
						label,
						grants: selected,
						expiresInDays: days,
						consent,
					})
				}}
			>
				<label className="block">
					Integration type
					<select
						aria-label="Integration type"
						value={kind}
						onChange={(event) => {
							const next = event.target.value as "personal" | "organization"
							setKind(next)
							setSelected(
								next === "personal"
									? [...personalGrants]
									: [...organizationGrants],
							)
							setConsent(false)
							setSecret(null)
						}}
						className="block rounded bg-[#17191E] p-2"
					>
						<option value="personal">My personal primary bot</option>
						{isAdmin && (
							<option value="organization">
								Organization integration (admin-only)
							</option>
						)}
					</select>
				</label>
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
					Expires in days (maximum {listing?.maxLifetimeDays ?? 30})
					<Input
						type="number"
						min={1}
						max={listing?.maxLifetimeDays ?? 30}
						value={days}
						onChange={(e) => setDays(Number(e.target.value))}
						required
					/>
				</label>
				<fieldset>
					<legend>Explicit read/write grants</legend>
					{grants.map((grant) => (
						<label key={grant} className="mr-5 inline-flex items-center gap-2">
							<input
								type="checkbox"
								checked={selected.includes(grant)}
								onChange={(e) =>
									setSelected((current) =>
										e.target.checked
											? [...current, grant]
											: current.filter((g) => g !== grant),
									)
								}
							/>
							{grant}
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
					{kind === "personal"
						? "I authorize this bot/provider to receive the selected shared/personal knowledge and, when personal-write is selected, persist captures, corrections and retractions in MY personal memory without a Slack approval for each routine write."
						: "I authorize shared-company knowledge and organization-procedure disclosure to this external agent/provider."}
				</label>
				<Button
					type="submit"
					disabled={busy || !listing || !consent || !selected.length}
				>
					Create credential
				</Button>
			</form>
			<ul className="space-y-3">
				{listing?.credentials.map((credential) => (
					<li
						key={credential.id}
						className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 p-3"
					>
						<div>
							<p>
								{credential.label} ·{" "}
								{credential.kind === "personal"
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
		</div>
	)
}
