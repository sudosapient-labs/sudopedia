// Fictional Slack API fixture; drives the production strict verifier without
// network access. This does NOT verify a real installation or live Slack access.
export let employeeInChannel = true
export let slackFailure = false
export function setSlackFixture(member: boolean, failure = false) {
	employeeInChannel = member; slackFailure = failure
}
export const fakeSlackFetch: typeof fetch = async (input, init) => {
	init?.signal?.throwIfAborted()
	const method = new URL(String(input)).pathname.split("/").at(-1)
	if (slackFailure) return Response.json({ ok: false, error: "SECRET_FIXTURE_ERROR" })
	return Response.json(method === "auth.test" ? { ok: true, team_id: "T1", user_id: "UBOT" } :
		method === "users.info" ? { ok: true, user: { id: "UOWNER", team_id: "T1", deleted: false, is_bot: false } } :
		method === "conversations.list" ? { ok: true, channels: [{ id: "CPRIVATE", is_private: true, is_archived: false }] } :
		{ ok: true, members: employeeInChannel ? ["UBOT", "UOWNER"] : ["UBOT"] })
}
