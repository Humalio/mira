/**
 * Keeps count of work that runs outside any request (video finalisation), so that a
 * stopping server can refuse to start more and wait for what is already running.
 */
export function createWorkTracker() {
	const running = new Set<Promise<unknown>>();
	let accepting = true;
	return {
		/** False once the server is stopping: nothing new may be started. */
		get accepting(): boolean {
			return accepting;
		},
		/** How many pieces of work are running right now. */
		get active(): number {
			return running.size;
		},
		/** Count `work` as running until it settles; returns it unchanged. */
		track<T>(work: Promise<T>): Promise<T> {
			running.add(work);
			const done = () => running.delete(work);
			work.then(done, done);
			return work;
		},
		/** Stop accepting new work and resolve once everything already running is over. */
		async drain(): Promise<void> {
			accepting = false;
			while (running.size) await Promise.allSettled([...running]);
		}
	};
}
