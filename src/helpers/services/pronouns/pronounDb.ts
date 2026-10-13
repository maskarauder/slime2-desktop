import { PROJECT_URL } from '@/helpers/branding';
import { getAppVersion } from '@/helpers/appVersion';
import axios from 'axios';

const pronounDbAxios = axios.create({
	timeout: 1500,
	baseURL: 'https://pronoundb.org/api/v2',
});

const pronounDbApi = {
	async getLookup(platform: 'twitch', userId: string) {
		const appVersion = await getAppVersion();

		const users = await pronounDbAxios
			.get<
				Record<
					string,
					{
						sets: Record<string, string[]>;
						decoration?: string;
					}
				>
			>('/lookup', {
				headers: {
					// as requested by PronounDB API https://pronoundb.org/wiki/api-docs
					'X-PronounDB-Source': `Slippy2-Desktop/${appVersion} (${PROJECT_URL})`,
				},
				params: {
					platform,
					ids: userId,
				},
			})
			.then(response => {
				return response.data;
			})
			.catch(() => null);

		if (!users) return null;

		const user = users[userId];
		if (!user) return null;

		const pronouns = user.sets?.['en'] ?? null;
		if (!pronouns || pronouns.length === 0) return null;

		if (pronouns.length === 1 && !!nominativePronounsMap[pronouns[0]!]) {
			return nominativePronounsMap[pronouns[0]!];
		}

		return pronouns;
	},
};

export default pronounDbApi;

const nominativePronounsMap: Record<string, string[]> = {
	he: ['he', 'him'],
	it: ['it', 'its'],
	she: ['she', 'her'],
	they: ['they', 'them'],
};
