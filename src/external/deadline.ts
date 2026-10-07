/** Bound awaits even when a local DB/RPC operation cannot itself be cancelled.
 * The underlying promise remains observed, but no subsequent work is admitted. */
export function withAbort<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		// The operation may have started before this helper saw cancellation.
		void Promise.resolve(promise).catch(() => {})
		return Promise.reject(signal.reason)
	}
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason)
		signal.addEventListener("abort", abort, { once: true })
		Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
	})
}
export function deadlineSignal(deadline: number, cancellation?: AbortSignal): AbortSignal {
	const timeout = deadline <= Date.now() ? AbortSignal.abort(new DOMException("Deadline exceeded", "TimeoutError"))
		: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - Date.now())))
	return cancellation ? AbortSignal.any([timeout, cancellation]) : timeout
}
