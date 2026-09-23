import type { ButtonHTMLAttributes, ReactNode } from 'react';
export function ToolSection({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<section className='flex flex-col gap-3 rounded-2 border border-zinc-300 bg-white p-4'>
			<h2 className='text-4.5 font-bold'>{title}</h2>
			{children}
		</section>
	);
}
export function ToolButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			type='button'
			{...props}
			className={`rounded-1 border border-zinc-300 bg-zinc-100 px-3 py-1.5 font-semibold hover:bg-lime-100 focus-visible:outline-2 disabled:opacity-50 ${props.className ?? ''}`}
		/>
	);
}
export const toolInputClass =
	'w-full rounded-1 border border-zinc-400 bg-white px-2 py-1.5 text-zinc-900';
export const platformNames = {
	twitch: 'Twitch',
	youtube: 'YouTube',
	tiktok: 'TikTok',
};
