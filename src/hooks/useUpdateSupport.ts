import { useQuery } from '@tanstack/react-query';
import { getUpdateSupport } from '@/helpers/commands';

export function useUpdateSupport() {
	return useQuery({
		queryKey: ['updateSupport'],
		queryFn: getUpdateSupport,
		staleTime: Infinity,
		networkMode: 'always',
		retry: false,
	});
}
