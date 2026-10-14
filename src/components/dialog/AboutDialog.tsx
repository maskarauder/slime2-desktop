import {
	APP_NAME,
	FORK_NOTICE,
	PROJECT_URL,
	UPSTREAM_URL,
} from '@/helpers/branding';
import useAppVersionQuery from '@/hooks/useAppVersionQuery';
import ExternalLink from '../ExternalLink';
import DialogCancelButton from './DialogButton/DialogCancelButton';
import DialogContent from './DialogContent';

const linkClass = 'font-medium text-sky-800 underline underline-offset-2';

export default function AboutDialog() {
	const appVersionQuery = useAppVersionQuery();

	return (
		<DialogContent className='flex w-200 max-w-[calc(100vw-2rem)] flex-col gap-4 p-5'>
			<div className='min-h-0 flex-1 overflow-y-auto pr-1'>
				<header className='mb-4 flex items-center gap-4'>
					<div>
						<h1 className='font-fredoka text-7 font-medium text-zinc-800'>
							{APP_NAME}
						</h1>
						<p className='text-3.5 text-zinc-600'>
							Independent Slime2 fork · Maintained by Maskarauder
							{appVersionQuery.data &&
								` · v${appVersionQuery.data}`}
						</p>
					</div>
				</header>

				<div className='flex flex-col gap-3 text-3.5 text-zinc-800'>
					<p className='rounded-2 border border-sky-200 bg-sky-50 p-3'>
						{FORK_NOTICE}
					</p>
					<section className='rounded-2 border border-zinc-300 bg-white p-3'>
						<h2 className='mb-2 font-bold'>{APP_NAME} support</h2>
						<div className='flex flex-wrap gap-x-5 gap-y-2'>
							{[
								['Source code', PROJECT_URL],
								['Releases', `${PROJECT_URL}/releases`],
								['Report an issue', `${PROJECT_URL}/issues`],
								[
									'License and notices',
									`${PROJECT_URL}/blob/main/NOTICE.md`,
								],
							].map(([label, href]) => (
								<ExternalLink
									key={label}
									href={href!}
									className={linkClass}
								>
									{label}
								</ExternalLink>
							))}
						</div>
					</section>

					<section className='rounded-2 border border-zinc-300 bg-white p-3'>
						<h2 className='mb-2 font-bold'>
							Independent development
						</h2>
						<p>
							This fork includes generative-AI-assisted
							contributions. The upstream README states that
							repository contents are not to be used in
							machine-learning models and that forks and pull
							requests with generative-AI contributions will not
							be accepted. Maskarauder chose to detach this
							repository in response to that published policy; the
							author did not contact the maintainer directly to
							request detachment.
						</p>
					</section>

					<section className='rounded-2 border border-zinc-300 bg-white p-3'>
						<h2 className='mb-2 font-bold'>
							Original project and credits
						</h2>
						<p>
							Derived from{' '}
							<ExternalLink
								href={UPSTREAM_URL}
								className={linkClass}
							>
								Slime2 Desktop
							</ExternalLink>{' '}
							by{' '}
							<ExternalLink
								href='https://zaytri.com/'
								className={linkClass}
							>
								Zaytri
							</ExternalLink>{' '}
							and contributors. Distributed under
							AGPL-3.0-or-later; original license and copyright
							notices are retained.
						</p>
						<p className='mt-2'>
							Original Slime2 logo: Bri,{' '}
							<ExternalLink
								href='https://sidequestdesigns.com/'
								className={linkClass}
							>
								Sidequest Designs
							</ExternalLink>
							. Original icons and artwork:{' '}
							<ExternalLink
								href='https://ko-fi.com/shenanjegans'
								className={linkClass}
							>
								Anje
							</ExternalLink>
							.
						</p>
					</section>
				</div>
			</div>

			<div className='flex shrink-0 justify-end'>
				<DialogCancelButton actionText='Close' />
			</div>
		</DialogContent>
	);
}
