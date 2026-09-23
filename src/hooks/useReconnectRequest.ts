import { useEffect, useRef, useState } from 'react';
import { subscribeReconnect } from '@/helpers/connectionStatus';
export function useReconnectRequest(callback: (id: string) => boolean) {
	const latest = useRef(callback);
	latest.current = callback;
	const [revision, setRevision] = useState(0);
	useEffect(
		() =>
			subscribeReconnect(id => {
				if (latest.current(id)) setRevision(value => value + 1);
			}),
		[],
	);
	return revision;
}
