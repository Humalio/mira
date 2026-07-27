import { operatorInfo } from '#lib/server/operator.js';
import type { LayoutServerLoad } from './$types';

/**
 * Expose to every route (layout data cascades into pages) the per-viewer locale, theme and
 * what the operator says about this copy: who runs it and how long photos are kept.
 */
export const load: LayoutServerLoad = ({ locals }) => ({
	locale: locals.locale,
	theme: locals.theme,
	operator: operatorInfo()
});
