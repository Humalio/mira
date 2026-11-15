// Home page behaviour: the hero picture, the scrolling story and the tabs.
// Everything here is decoration on top of a page that already reads correctly without it.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---- Hero: let everyone's photos arrive (home.css scales the picture to its column) ---- */
{
	const wrap = document.querySelector('.hero-visual');
	const stage = wrap?.querySelector('.stage');
	if (wrap && stage) {
		// Browsers from before 2023 cannot work the scale out in CSS; give them the same one.
		if (!CSS.supports('scale', 'tan(atan2(1cqi, 1px))')) {
			const fit = () => stage.style.setProperty('--s', String(Math.min(1, wrap.clientWidth / stage.offsetWidth)));
			fit();
			addEventListener('resize', fit);
		}

		const count = stage.querySelector('.count');
		const order = [
			{ who: 'alex', at: 350 },
			{ who: 'marta', at: 1250 },
			{ who: 'tomas', at: 2150 },
			{ who: 'ines', at: 3050 }
		];
		// centre of an element in the stage's own (unscaled) coordinates
		const centre = (el) => {
			const r = el.getBoundingClientRect();
			const sr = stage.getBoundingClientRect();
			const s = sr.width / stage.offsetWidth;
			return { x: (r.left + r.width / 2 - sr.left) / s, y: (r.top + r.height / 2 - sr.top) / s };
		};
		const play = () => {
			const tiles = [...stage.querySelectorAll('.tile')];
			let n = 0;
			count.textContent = '0';
			for (const { who, at } of order) {
				const sender = stage.querySelector(`.sender[data-who="${who}"]`);
				const small = sender.querySelector('small');
				const from = centre(sender.querySelector('.avatar'));
				sender.classList.remove('done');
				small.textContent = small.dataset.todo;
				setTimeout(() => sender.classList.add('ping'), at);
				tiles
					.filter((t) => t.dataset.by === who)
					.forEach((tile, i) => {
						const to = centre(tile);
						const delay = at + i * 170;
						const turn = (who === 'marta' || who === 'ines' ? 1 : -1) * (6 + i * 4);
						tile.animate(
							[
								{
									transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(0.25) rotate(${turn}deg)`,
									opacity: 0
								},
								{ opacity: 1, offset: 0.2 },
								{ transform: 'none', opacity: 1 }
							],
							{ duration: 850, delay, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }
						);
						if (!tile.classList.contains('pending')) setTimeout(() => (count.textContent = String(++n)), delay + 700);
					});
				setTimeout(() => {
					sender.classList.add('done');
					small.textContent = small.dataset.done;
				}, at + 900);
			}
		};
		// once the names on the tags have their final width, so the photos fly from the right place
		(document.fonts?.ready ?? Promise.resolve()).then(() => {
			if (!reduceMotion) play();
			else stage.querySelectorAll('.sender').forEach((s) => s.classList.add('done'));
		});
	}
}

/* ---- Story: the phone follows the scroll, crossfading between its four screens ---- */
{
	const steps = [...document.querySelectorAll('.sstep')];
	const scenes = [...document.querySelectorAll('.sphone .scene')];
	if (steps.length && scenes.length) {
		// the reading line: the middle of the screen, or just below the pinned phone on small screens
		const line = () => (innerWidth <= 700 ? Math.min(innerHeight * 0.62, 400) : innerHeight * 0.5);
		// a continuous position: 0 = middle of step 1, 1 = middle of step 2, ...
		const target = () => {
			const y = line();
			const tops = steps.map((s) => s.getBoundingClientRect().top);
			tops.push(steps[steps.length - 1].getBoundingClientRect().bottom);
			let p = 0;
			for (let i = 0; i < steps.length; i++) {
				if (y >= tops[i]) p = i + Math.min(1, (y - tops[i]) / (tops[i + 1] - tops[i]));
			}
			return Math.max(0, Math.min(steps.length - 1, p - 0.5));
		};
		const clamp = (v) => Math.max(0, Math.min(1, v));
		let pos = target();
		const paint = () => {
			scenes.forEach((s) => {
				const d = pos - Number(s.dataset.i);
				const o = clamp((0.65 - Math.abs(d)) / 0.3); // half and half exactly between two steps
				s.style.opacity = o.toFixed(3);
				s.style.visibility = o > 0 ? 'visible' : 'hidden';
				s.style.transform = `translateY(${(-d * 26).toFixed(1)}px) scale(${(0.965 + 0.035 * o).toFixed(4)})`;
			});
			// the other steps recede by colour, not opacity, so their text keeps its contrast (home.css)
			steps.forEach((s, i) => {
				const o = clamp((0.75 - Math.abs(pos - i)) / 0.5);
				s.style.setProperty('--focus', o.toFixed(3));
			});
		};
		let running = false;
		const tick = () => {
			const t = target();
			pos += (t - pos) * (reduceMotion ? 1 : 0.16);
			if (Math.abs(t - pos) < 0.002) pos = t;
			paint();
			if (pos !== t) requestAnimationFrame(tick);
			else running = false;
		};
		const kick = () => {
			if (running) return;
			running = true;
			requestAnimationFrame(tick);
		};
		addEventListener('scroll', kick, { passive: true });
		addEventListener('resize', kick);
		paint();
	}
}

/* ---- Tabs: group chat vs Mira, and good to know ---- */
// Without this both panels are simply shown one after the other (home.css).
{
	const tabs = [...document.querySelectorAll('.tabbar [role="tab"]')];
	const select = (tab, focus = false) => {
		tabs.forEach((t) => {
			const on = t === tab;
			t.setAttribute('aria-selected', String(on));
			t.tabIndex = on ? 0 : -1;
			document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
		});
		if (focus) tab.focus();
	};
	if (tabs.length) {
		tabs[0].closest('.tabs-section')?.classList.add('tabbed');
		select(tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0]);
	}
	tabs.forEach((t, i) => {
		t.addEventListener('click', () => select(t));
		t.addEventListener('keydown', (e) => {
			const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
			if (d) select(tabs[(i + d + tabs.length) % tabs.length], true);
		});
	});
	document.querySelectorAll('[data-tab]').forEach((a) =>
		a.addEventListener('click', () => {
			const tab = document.getElementById(`tab-${a.dataset.tab}`);
			if (tab) select(tab);
		})
	);
}
