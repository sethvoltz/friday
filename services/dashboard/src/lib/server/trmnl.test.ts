import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pushMenuToTRMNL, type KitchenMenu } from './trmnl.js';

const WEBHOOK = 'https://usetrmnl.com/api/custom_plugins/test-abc';

const sampleMenu: KitchenMenu = {
	weekId: '2026-W21',
	monDate: '2026-05-18',
	nights: [
		{ day: 'Mon', dish: 'Shakshuka', note: 'Meatless Monday' },
		{ day: 'Tue', dish: 'Larb Gai', note: 'Turkey thawed Tue' },
		{ day: 'Wed', dish: 'Pasta' },
		{ day: 'Thu', dish: 'SKIP' },
		{ day: 'Fri', dish: 'Pizza night' }
	]
};

describe('pushMenuToTRMNL', () => {
	beforeEach(() => {
		delete process.env.TRMNL_KITCHEN_WEBHOOK;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('no-ops and does not call fetch when TRMNL_KITCHEN_WEBHOOK is unset', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);

		await pushMenuToTRMNL(sampleMenu);

		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('no-ops when TRMNL_KITCHEN_WEBHOOK is empty string', async () => {
		vi.stubEnv('TRMNL_KITCHEN_WEBHOOK', '');
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);

		await pushMenuToTRMNL(sampleMenu);

		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('POSTs to webhook URL with correct method and Content-Type', async () => {
		vi.stubEnv('TRMNL_KITCHEN_WEBHOOK', WEBHOOK);
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-18T10:00:00Z')); // Monday
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
		vi.stubGlobal('fetch', fetchMock);

		await pushMenuToTRMNL(sampleMenu);

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(WEBHOOK);
		expect(opts.method).toBe('POST');
		expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
	});

	it('body matches expected schema for a Monday push', async () => {
		vi.stubEnv('TRMNL_KITCHEN_WEBHOOK', WEBHOOK);
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-18T10:00:00Z')); // Monday
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
		vi.stubGlobal('fetch', fetchMock);

		await pushMenuToTRMNL(sampleMenu);

		const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
		expect(body).toMatchObject({
			merge_variables: {
				week_id: '2026-W21',
				mon_date: 'May 18',
				today: 'Mon',
				tonight: 'Shakshuka',
				tonight_note: 'Meatless Monday',
				nights: expect.arrayContaining([
					{ day: 'Mon', dish: 'Shakshuka', note: 'Meatless Monday' },
					{ day: 'Wed', dish: 'Pasta' },
					{ day: 'Thu', dish: 'SKIP' }
				])
			}
		});
		expect(body.merge_variables.nights).toHaveLength(5);
	});

	it('sets tonight to "—" when today has no matching night', async () => {
		vi.stubEnv('TRMNL_KITCHEN_WEBHOOK', WEBHOOK);
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-23T10:00:00Z')); // Saturday — not in menu
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
		vi.stubGlobal('fetch', fetchMock);

		await pushMenuToTRMNL(sampleMenu);

		const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
		expect(body.merge_variables.tonight).toBe('—');
		expect(body.merge_variables).not.toHaveProperty('tonight_note');
	});

	it('sets tonight to "—" when tonight dish is SKIP', async () => {
		vi.stubEnv('TRMNL_KITCHEN_WEBHOOK', WEBHOOK);
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-21T10:00:00Z')); // Thursday — SKIP
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
		vi.stubGlobal('fetch', fetchMock);

		await pushMenuToTRMNL(sampleMenu);

		const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
		expect(body.merge_variables.tonight).toBe('—');
	});

	it('truncates note fields longer than 60 chars', async () => {
		vi.stubEnv('TRMNL_KITCHEN_WEBHOOK', WEBHOOK);
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-18T10:00:00Z')); // Monday
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
		vi.stubGlobal('fetch', fetchMock);

		const longNote = 'A'.repeat(80);
		const menu: KitchenMenu = {
			...sampleMenu,
			nights: [{ day: 'Mon', dish: 'Test dish', note: longNote }]
		};

		await pushMenuToTRMNL(menu);

		const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
		const night = body.merge_variables.nights[0];
		expect(night.note.length).toBe(60);
		expect(night.note.endsWith('…')).toBe(true);
	});

	it('resolves without throwing when fetch rejects', async () => {
		vi.stubEnv('TRMNL_KITCHEN_WEBHOOK', WEBHOOK);
		const fetchMock = vi.fn().mockRejectedValue(new Error('network error'));
		vi.stubGlobal('fetch', fetchMock);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(pushMenuToTRMNL(sampleMenu)).resolves.toBeUndefined();
		expect(errorSpy).toHaveBeenCalledWith('[trmnl] push failed', expect.any(Error));
	});

	it('resolves without throwing when fetch returns non-ok status', async () => {
		vi.stubEnv('TRMNL_KITCHEN_WEBHOOK', WEBHOOK);
		const fetchMock = vi
			.fn()
			.mockResolvedValue({ ok: false, status: 422, text: async () => 'bad input' });
		vi.stubGlobal('fetch', fetchMock);
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(pushMenuToTRMNL(sampleMenu)).resolves.toBeUndefined();
		expect(errorSpy).toHaveBeenCalledWith('[trmnl] push failed', 422, 'bad input');
	});
});
