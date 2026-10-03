import { useEffect, useState } from "react"
import { useAuth } from "@lib/auth-context"
import { Button } from "@ui/components/button"
import { Input } from "@ui/components/input"

type Credential = {
	id: string
	label: string
	grants: string[]
	expiresAt: number
	revokedAt: number | null
}
type Listing = {
	credentials: Credential[]
	mcpUrl: string
	maxLifetimeDays: number
}
const grants = ["memory.shared:read", "skills.org:read"] as const

export default function ExternalAccess() {
	const { isAdmin, org } = useAuth()
	const [listing, setListing] = useState<Listing | null>(null)
	const [label, setLabel] = useState("")
	const [days, setDays] = useState(7)
	const [selected, setSelected] = useState<string[]>([...grants])
	const [consent, setConsent] = useState(false)
	const [secret, setSecret] = useState<string | null>(null)
	const [error, setError] = useState("")
	const [busy, setBusy] = useState(false)
	const endpoint = "/brain/external-credentials/"
	const refresh = async () => {
		const response = await fetch(endpoint, {
			credentials: "include",
			cache: "no-store",
		})
		const body = await response.json()
		if (!response.ok)
			throw new Error(body.error?.message ?? "Unable to load credentials")
		setListing(body)
	}
	useEffect(() => {
		setSecret(null)
		setListing(null)
		if (isAdmin) void refresh().catch((e) => setError(e.message))
	}, [isAdmin, org?.id])
	const mutate = async (path: string, body: unknown) => {
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
			if (result.secret) setSecret(result.secret)
			await refresh()
		} catch (e) {
			setError(e instanceof Error ? e.message : "Operation failed")
		} finally {
			setBusy(false)
		}
	}
	if (!isAdmin)
		return (
			<p className="text-sm text-[#8B929E]">
				Only organization owners/admins can manage external access.
			</p>
		)
	return (
		<div className="space-y-5 text-sm text-[#FAFAFA]">
			<p className="rounded-lg border border-amber-500/30 p-4 text-amber-100">
				Connecting an external agent discloses shared company knowledge and
				organization procedures to its operator/provider. Revocation blocks
				future reads; downloaded context cannot be recalled. No private memory,
				personal skills, writes or external actions are enabled.
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
					<legend>Read grants</legend>
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
					I authorize shared-company data disclosure to this external
					agent/provider.
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
							<p>{credential.label}</p>
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
										`Revoke ${credential.label}? Future reads will be denied.`,
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
