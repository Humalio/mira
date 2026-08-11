import postgres from 'postgres';
import { reconcileStorageCounters } from './admin';
import { cleanupExpiredUploadSessions } from './uploads';
import { finalizations, finalizeReady, resumeInterruptedFinalizations } from './video-finalize';
import { drainMediaDeletions } from './media-deletions';

const SWEEP_INTERVAL_MS = 5 * 60_000;
const RECONCILE_INTERVAL_MS = 24 * 60 * 60_000;
const SINGLETON_WAIT_MS = 90_000;
let started = false;

async function sweep(): Promise<void> {
	await drainMediaDeletions().catch((cause) => console.error('[maintenance] deletion sweep failed', cause));
	try {
		await cleanupExpiredUploadSessions();
	} catch (cause) {
		console.error('[maintenance] upload-session sweep failed', cause);
	}
	// Videos that are fully uploaded and waiting for a free finaliser, or waiting to be
	// tried again, are started from here, so none depends on its uploader's page.
	await finalizeReady().catch((cause) => console.error('[maintenance] waiting uploads could not be started', cause));
	// Quarantine legacy trash until a durable deletion journal can prove commit.
	// Age alone cannot distinguish a committed deletion from a crash rollback.
}

async function reconcile(): Promise<void> {
	try {
		await reconcileStorageCounters();
	} catch (cause) {
		console.error('[maintenance] storage counter reconciliation failed', cause);
	}
}

/**
 * Mira keeps rate limits, processing slots and upload-finalisation state in process
 * memory, so exactly one server may run against a database. Hold a session-level
 * advisory lock for the life of the process; a second replica waits briefly (the
 * previous container may still be draining during a redeploy) and then refuses to
 * start instead of silently doubling every limit.
 */
async function claimSingleInstance(): Promise<void> {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error('DATABASE_URL is required');
	let ownsLock = false;
	let stopping = false;
	const client = postgres(url, {
		max: 1,
		connect_timeout: 10,
		idle_timeout: 0,
		max_lifetime: null,
		connection: { application_name: 'mira-singleton' },
		onclose: () => {
			if (ownsLock && !stopping) {
				console.error('[startup] singleton lock connection lost; terminating');
				process.exit(1);
			}
		}
	});
	const deadline = Date.now() + SINGLETON_WAIT_MS;
	for (;;) {
		const [row] = await client`select pg_try_advisory_lock(hashtext('mira:single-instance')) as locked`;
		if (row.locked) {
			ownsLock = true;
			break;
		}
		if (Date.now() > deadline) {
			await client.end();
			throw new Error(
				'Another Mira server holds this database. Mira is single-instance: stop the other one, or see https://github.com/Humalio/mira/blob/main/docs/DEPLOYMENT.md.'
			);
		}
		console.warn('[startup] waiting for the previous Mira instance to release the database');
		await new Promise((resolve) => setTimeout(resolve, 5_000));
	}
	// Keep the lock connection alive for the process lifetime; release on graceful stop.
	// "Stop" means the web server has closed, not that the work is over: a video being
	// put together or compressed keeps this process alive after it. The lock is what
	// tells a new instance that nobody else is finalising (it clears half-made output and
	// starts those videos again), so it is given up only once that work has ended. If it
	// takes longer than the container's stop period the process is killed, and the lock
	// goes with its connection.
	process.once('sveltekit:shutdown', () => {
		stopping = true;
		void finalizations.drain().finally(() => client.end({ timeout: 5 }));
	});
}

/** Start the single-node housekeeping loops. */
export async function startMaintenance(): Promise<void> {
	if (started) return;
	started = true;
	if (process.env.NODE_ENV === 'production') {
		await claimSingleInstance();
		// Safe only because the lock above guarantees no other process is finalising.
		await resumeInterruptedFinalizations().catch((cause) =>
			console.error('[maintenance] interrupted finalisation recovery failed', cause)
		);
	}
	void sweep();
	void reconcile();
	setInterval(() => void sweep(), SWEEP_INTERVAL_MS).unref();
	setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS).unref();
}
