export class ExternalError extends Error {
	constructor(
		readonly code: string,
		readonly status:
			| 400
			| 401
			| 403
			| 404
			| 409
			| 413
			| 415
			| 429
			| 502
			| 503
			| 504,
		message: string,
		readonly details?: { currentVersion: number },
	) {
		super(message)
	}
}

export function publicError(error: unknown): ExternalError {
	return error instanceof ExternalError
		? error
		: new ExternalError("unavailable", 503, "External access unavailable")
}

export function errorBody(error: unknown) {
	const safe = publicError(error)
	return { error: { code: safe.code, message: safe.message, ...safe.details } }
}
