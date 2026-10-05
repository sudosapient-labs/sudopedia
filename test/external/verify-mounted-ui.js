// Run in the native preview after mounting dist/external-ui-fixture/ui-preview.js.
// Fictional auth/fetch and instrumented storage, NOT browser-to-gateway evidence.
globalThis.verifyMountedExternalUi = async () => {
	const assert = (ok, message) => { if (!ok) throw new Error(message) }
	const tick = () => new Promise((resolve) => {
		const channel = new MessageChannel()
		channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve() }
		channel.port2.postMessage(null)
	})
	const wait = async (test) => {
		for (let i = 0; i < 200; i++) { if (test()) return; await tick() }
		throw new Error("Mounted UI condition timed out")
	}
	const grants = () => [...document.querySelectorAll("fieldset input")]
	const consent = () => document.querySelector('form input[type="checkbox"][required]')
	const create = () => document.querySelector('button[type="submit"]')
	const button = (text) => [...document.querySelectorAll("button")].find((b) => b.textContent === text)
	const fill = (input, value) => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value)
		input.dispatchEvent(new Event("input", { bubbles: true }))
	}
	const writes = []
	for (const name of ["localStorage", "sessionStorage"]) Object.defineProperty(globalThis, name, {
		configurable: true, value: { setItem: (...args) => writes.push(args), getItem: () => null,
			removeItem() {}, clear() {}, length: 0, key: () => null },
	})
	__remountExternalUi(false)
	await wait(() => grants().length === 4)
	assert(!document.querySelector("select"), "Integration-kind dropdown remains")
	assert(create().disabled && !consent().checked, "Consent is required")
	assert(document.querySelector('input[type="number"]').max === "365", "365-day UI policy")
	assert(grants().every((i) => !["skills.org:read", "memory.shared:write"].includes(i.getAttribute("aria-label"))), "Employee privileged grants")
	__remountExternalUi(true)
	await wait(() => grants().length === 6)
	document.querySelector('[aria-label="memory.shared:write"]').click()
	document.querySelector('[aria-label="skills.org:read"]').click()
	consent().click()
	await wait(() => !create().disabled)
	document.querySelector('[aria-label="memory.private-channel:read"]').click()
	await wait(() => create().disabled && !consent().checked)
	consent().click()
	const mint = async (n) => {
		fill(document.querySelector('form label:first-of-type input'), `Mounted fictional mixed ${n}`)
		fill(document.querySelector('input[type="number"]'), "365")
		await wait(() => !create().disabled)
		create().click()
		// Flush the submission render before observing the previous mint's textarea.
		await tick()
		await wait(() => document.querySelector("textarea") && !create().disabled)
		const request = __externalUiRequests.findLast((r) => r.body?.label === `Mounted fictional mixed ${n}`)
		assert(request?.body.kind === "employee" && request.body.consent && request.body.expiresInDays === 365, "Mixed creation contract")
		assert(request.body.grants.length === 6, "Combined ordinary/admin consent")
		assert(/^sd_ext_/.test(document.querySelector("textarea").value), "One-time secret missing")
	}
	await mint(1); await mint(2); await mint(3)
	assert(writes.length === 0, "Component wrote secret/browser persistence")
	assert(button("Load more credentials"), "Missing pagination")
	while (button("Load more credentials")) {
		const previous = document.querySelectorAll("ul li").length
		button("Load more credentials").click()
		await wait(() => document.querySelectorAll("ul li").length > previous || !button("Load more credentials"))
	}
	assert(__externalUiRequests.some((r) => r.body?.cursor), "Body-only pagination not used")
	__remountExternalUi(true)
	await wait(() => !!create() && grants().length === 6)
	assert(!document.querySelector("textarea"), "Secret survived remount")
	assert(!consent().checked && create().disabled, "Consent survived remount")
	return { employeeChoices: 4, adminChoices: 6, mixedConsent: true, consentResets: true,
		maxDays: 365, componentStorageWrites: 0, secretRemovedOnRemount: true, pagination: true,
		evidence: "mounted component with fictional auth/fetch and instrumented storage" }
}
