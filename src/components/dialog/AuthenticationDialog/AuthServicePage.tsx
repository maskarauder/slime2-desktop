import { usePage } from '@/contexts/pages/usePage';
import { usePageContext } from '@/contexts/pages/usePageContext';
import MusicNotesSvg from '@@/svg/MusicNoteSvg';
import TwitchSvg from '@@/svg/TwitchSvg';
import YoutubeSvg from '@@/svg/YoutubeSvg';
import type { AuthenticationContext, AuthenticationPages } from '.';

export default function AuthServicePage() {
	const { setPage } = usePage<AuthenticationPages>();
	const { setService, type } = usePageContext<AuthenticationContext>();

	return (
		<div className='gap-4t flex flex-1 flex-col items-center'>
			<button
				className='group/button relative flex items-center gap-2 overflow-hidden rounded-2 bg-[#9146FF] px-4 py-2 font-fredoka text-5 font-medium text-white outline-2 -outline-offset-1! outline-violet-700 over:outline-4 over:outline-violet-800'
				onClick={() => {
					setService('twitch');
					setPage('twitch');
				}}
			>
				<div className='absolute inset-0 bottom-1/2 bg-linear-to-b from-white/25 to-white/15 group-over/button:hidden'></div>
				<TwitchSvg className='size-5 drop-shadow-[0_1px_#0006]' />
				<p className='text-shadow-[0_1px_#0006]'>Connect with Twitch</p>
			</button>

			{type === 'read' && (
				<>
					<button
						className='group/button relative flex items-center gap-2 overflow-hidden rounded-2 bg-[#ff0033] px-4 py-2 font-fredoka text-5 font-medium text-white outline-2 -outline-offset-1! outline-red-700 over:outline-4 over:outline-red-800'
						onClick={() => {
							setService('youtube');
							setPage('youtube');
						}}
					>
						<div className='absolute inset-0 bottom-1/2 bg-linear-to-b from-white/25 to-white/15 group-over/button:hidden'></div>
						<YoutubeSvg className='size-5 drop-shadow-[0_1px_#0006]' />
						<p className='text-shadow-[0_1px_#0006]'>
							Connect with YouTube
						</p>
					</button>

					<button
						className='group/button relative flex items-center gap-2 overflow-hidden rounded-2 bg-zinc-950 px-4 py-2 font-fredoka text-5 font-medium text-white outline-2 -outline-offset-1! outline-cyan-400 over:outline-4 over:outline-pink-500'
						onClick={() => {
							setService('tiktok');
							setPage('tiktok');
						}}
					>
						<div className='absolute inset-0 bottom-1/2 bg-linear-to-b from-white/25 to-white/10 group-over/button:hidden'></div>
						<MusicNotesSvg className='size-5 text-cyan-300 drop-shadow-[2px_1px_#fe2c55]' />
						<p className='text-shadow-[0_1px_#0006]'>
							Connect TikTok LIVE (Experimental)
						</p>
					</button>
				</>
			)}
		</div>
	);
}
