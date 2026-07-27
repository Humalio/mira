/**
 * UI attention budget — a tiny weighted allocator for action surfaces.
 *
 * Treat the visible chrome as a constrained minimization: each action has a
 * `value` (importance × frequency) and a `cost` (space/attention it takes when
 * shown). Given a budget, we greedily place the highest value-per-cost actions
 * into the visible surface; everything else overflows into a menu (still
 * reachable in one extra tap). Unavailable actions (e.g. Download with nothing
 * to download) are dropped entirely — value 0 ⇒ never on screen.
 */
export type UiAction = {
	id: string;
	label: string;
	value: number;
	cost: number;
	/** default true; false removes the action from both visible and overflow */
	available?: boolean;
};

export type Allocation = { visible: UiAction[]; overflow: UiAction[] };

export function allocate(actions: UiAction[], budget: number): Allocation {
	const avail = actions.filter((a) => a.available !== false);
	const ranked = [...avail].sort((a, b) => b.value / b.cost - a.value / a.cost);

	const visibleIds = new Set<string>();
	let spent = 0;
	for (const a of ranked) {
		if (spent + a.cost <= budget) {
			visibleIds.add(a.id);
			spent += a.cost;
		}
	}

	// Keep declared order for stable, predictable rendering.
	return {
		visible: avail.filter((a) => visibleIds.has(a.id)),
		overflow: avail.filter((a) => !visibleIds.has(a.id))
	};
}
