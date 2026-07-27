/** Names compare without case, accents-as-typed or stray spaces: "Zoe", "zoe " and "ZOE" clash. */
export const nameKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/**
 * Labels for an album's members that are never identical. Guests pick their own name
 * and nothing stops two of them choosing the same one, which made the by-person lists
 * show indistinguishable rows. The first to join keeps the plain name; later ones get
 * a number: "Zoe", "Zoe (2)", "Zoe (3)". Pass members in joining order.
 */
export function distinctNames(members: { id: string; name: string }[]): Map<string, string> {
	const taken = new Set<string>();
	const seen = new Map<string, number>();
	const labels = new Map<string, string>();
	for (const member of members) {
		const name = member.name.trim();
		const key = nameKey(name);
		let n = (seen.get(key) ?? 0) + 1;
		let label = n === 1 ? name : `${name} (${n})`;
		// Someone may really be called "Zoe (2)"; skip any number already in use.
		while (taken.has(nameKey(label))) label = `${name} (${++n})`;
		seen.set(key, n);
		taken.add(nameKey(label));
		labels.set(member.id, label);
	}
	return labels;
}
