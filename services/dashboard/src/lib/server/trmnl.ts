const DAY_ABBRS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
type DayAbbr = (typeof DAY_ABBRS)[number];

const NOTE_MAX = 60;

export interface KitchenNight {
	day: string;
	dish: string;
	note?: string;
}

export interface KitchenMenu {
	weekId: string; // "2026-W21"
	monDate: string; // ISO "2026-05-18"
	nights: KitchenNight[];
}

function todayAbbr(): DayAbbr {
	return DAY_ABBRS[new Date().getDay()];
}

function formatMonDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function trunc(s: string | undefined, max: number): string | undefined {
	if (!s || s.length <= max) return s;
	return s.slice(0, max - 1) + '…';
}

export async function pushMenuToTRMNL(menu: KitchenMenu): Promise<void> {
	const webhookUrl = process.env.TRMNL_KITCHEN_WEBHOOK;
	if (!webhookUrl) {
		console.debug('[trmnl] TRMNL_KITCHEN_WEBHOOK not set — skipping push');
		return;
	}

	const today = todayAbbr();
	const tonightNight = menu.nights.find((n) => n.day === today);
	const rawDish = tonightNight?.dish;
	const tonight = !rawDish || rawDish === 'SKIP' ? '—' : rawDish;
	const tonightNote = trunc(tonightNight?.note, NOTE_MAX);

	const nights = menu.nights.map((n) => ({
		day: n.day,
		dish: n.dish,
		...(n.note ? { note: trunc(n.note, NOTE_MAX) } : {})
	}));

	const payload: Record<string, unknown> = {
		week_id: menu.weekId,
		mon_date: formatMonDate(menu.monDate),
		nights,
		today,
		tonight,
		...(tonightNote ? { tonight_note: tonightNote } : {})
	};

	const body = JSON.stringify({ merge_variables: payload });

	if (Buffer.byteLength(body, 'utf8') > 2048) {
		console.error('[trmnl] payload exceeds 2 KB — skipping push');
		return;
	}

	try {
		const res = await fetch(webhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			console.error('[trmnl] push failed', res.status, text);
		}
	} catch (err) {
		console.error('[trmnl] push failed', err);
	}
}
